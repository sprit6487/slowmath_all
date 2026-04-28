/**
 * 슬로매스 통합 쉘
 *
 * 책임:
 *  - 4탭 라우팅 (홈 / 기록 / 시리즈 / 마이)
 *  - 첫 랜딩 = 시리즈
 *  - 시리즈에서 고른 서비스를 홈 탭에 iframe으로 로드
 *  - 서브앱 ↔ 쉘 postMessage 브릿지 (play-requested / play-allowed / payment-required / record-saved)
 *  - Feature flag 기반 인증/이용권 게이트 (MVP: 모두 off — 통과)
 *  - localStorage 네임스페이스: sm.shell.*
 */
(function () {
  'use strict';

  // ---------------- 설정 ----------------
  var FLAGS = {
    // 인증은 풀스크린 로그인 뷰가 자동 처리. 이 플래그는 더 이상 사용하지 않으며
    // 향후 모달 기반 게이트가 부활할 경우를 위해 남겨둠.
    auth: false,
    ticket: false    // true가 되면 이용권/결제 게이트 활성화
  };

  var LS = {
    records:    'sm.shell.records',
    user:       'sm.shell.user',
    tickets:    'sm.shell.tickets',
    shareDays:  'sm.shell.share_days'
  };

  var SHARE_MAX = 10;

  var SPLASH_MS = 2400;  // 서브앱과 동일 — floating 애니메이션(2.4s/주기) 1주기 노출

  // MVP 편의: FLAGS.auth=false인 동안 서브앱 내부 로그인 게이트를 통과시키기 위해
  // 각 서브앱이 체크하는 로그인 키를 선주입한다. iframe은 쉘과 같은 origin이라
  // localStorage를 공유 → 쉘에서 set하면 iframe이 즉시 인식.
  // FLAGS.auth가 true가 되면 이 함수는 쉘 로그인 성공 시에만 호출한다.
  //
  // 대부분의 서브앱은 `slowmath_<id>_login` 패턴을 쓰지만, 일부는 비표준 키를
  // 사용하므로 아래 오버라이드 맵으로 보정한다.
  var LOGIN_KEY_OVERRIDES = {
    colorcopy:   'colorcopy_login',    // 'slowmath_' 접두사 없음
    matching:    'slowmath_login',      // 앱 id 없음 (공용 키 형태)
    timestables: 'slowmath_times_login' // 'timestables' → 'times'
  };

  function subappLoginKey(appId) {
    return LOGIN_KEY_OVERRIDES[appId] || ('slowmath_' + appId + '_login');
  }

  // (이전에는 seedSubappLogins로 MVP에서 강제 로그인 상태 주입했으나,
  //  이제 서브앱 로그인 뷰를 정식 로그인 화면으로 쓰므로 시드하지 않음)

  function clearAllSubappLogins() {
    try {
      window.SM_APPS.forEach(function (app) {
        localStorage.removeItem(subappLoginKey(app.id));
      });
    } catch (e) { /* noop */ }
  }

  // 한 서브앱에서 로그인하면 모든 서브앱에 로그인 키를 전파 (SSO 유사 UX)
  function propagateSubappLogin(loginInfo) {
    try {
      window.SM_APPS.forEach(function (app) {
        var key = subappLoginKey(app.id);
        if (!localStorage.getItem(key)) {
          localStorage.setItem(key, JSON.stringify(loginInfo || { provider: 'kakao', time: Date.now() }));
        }
      });
    } catch (e) { /* noop */ }
  }

  function isLoggedIn() {
    if (lsGet(LS.user, null)) return true;
    return !!anySubappLogin();
  }

  function anySubappLogin() {
    for (var i = 0; i < window.SM_APPS.length; i++) {
      var val = localStorage.getItem(subappLoginKey(window.SM_APPS[i].id));
      if (val) {
        try { return JSON.parse(val); } catch (e) { return { provider: 'kakao' }; }
      }
    }
    return null;
  }

  // 서브앱이 localStorage에 로그인 키를 set/remove 하면 스토리지 이벤트로 쉘이 감지,
  // 쉘 user 상태 + Mari 탭 + 다른 서브앱 로그인 전파까지 동기화
  function updateShellUserFromSubapps() {
    var loginInfo = anySubappLogin();
    var currentShellUser = lsGet(LS.user, null);
    if (loginInfo && !currentShellUser) {
      lsSet(LS.user, {
        id: 'subapp',
        name: '사용자',
        email: (loginInfo && loginInfo.email) || 'sprit6487@gmail.com',
        provider: (loginInfo && loginInfo.provider) || 'kakao',
        at: Date.now()
      });
      propagateSubappLogin(loginInfo);
      renderMy();
      updateLoginViewVisibility();
    } else if (!loginInfo && currentShellUser) {
      try { localStorage.removeItem(LS.user); } catch (e) {}
      renderMy();
      updateLoginViewVisibility();
    }
  }

  function setupSubappLoginSync() {
    window.addEventListener('storage', function (e) {
      if (!e.key) return;
      var isSubappKey = false;
      for (var i = 0; i < window.SM_APPS.length; i++) {
        if (subappLoginKey(window.SM_APPS[i].id) === e.key) { isSubappKey = true; break; }
      }
      if (isSubappKey) updateShellUserFromSubapps();
    });
    updateShellUserFromSubapps(); // 초기 sync
  }

  // ---------------- 상태 ----------------
  var NOW = new Date();
  var state = {
    activeTab: 'series',      // 시작 탭
    currentApp: null,         // id of app loaded in Home iframe
    iframeEl: null,
    pendingPlayRequest: null, // iframe 으로부터 대기 중인 play 요청 메타
    recordsView: 'picker',    // 'picker' | 'detail'
    recordsApp: null,         // detail 뷰에서 선택된 appId
    recordsCalYear: NOW.getFullYear(),
    recordsCalMonth: NOW.getMonth(),
    recordsSelectedDate: null, // 달력에서 선택된 날짜 (YYYY-MM-DD)
    recordsPeriod: 'month'     // 'month' | '7d' | '30d' | '90d' | 'all'
  };

  var MONTH_NAMES = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];

  var RECORDS_PERIODS = [
    { id: 'month', label: '월별' },
    { id: '7d',    label: '지난 7일' },
    { id: '30d',   label: '지난 30일' },
    { id: '90d',   label: '지난 3개월' },
    { id: 'all',   label: '전체 기간' }
  ];

  // 선택된 기간의 시작/끝 ISO 날짜 반환 (YYYY-MM-DD). null = 무제한
  function getPeriodRange(periodId) {
    var end = new Date();
    var start;
    if (periodId === '7d')  { start = new Date(); start.setDate(start.getDate() - 6); }
    else if (periodId === '30d') { start = new Date(); start.setDate(start.getDate() - 29); }
    else if (periodId === '90d') { start = new Date(); start.setDate(start.getDate() - 89); }
    else if (periodId === 'all') { return { start: null, end: null, label: '전체 기간' }; }
    else { return null; }
    var fmt = function (d) {
      return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    };
    return { start: fmt(start), end: fmt(end), label: start.getMonth()+1 + '월 ' + start.getDate() + '일 ~ ' + (end.getMonth()+1) + '월 ' + end.getDate() + '일' };
  }

  // ---------------- 유틸 ----------------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function lsGet(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* noop */ }
  }

  // ---------------- 스플래시 ----------------
  function hideSplash() {
    var el = $('#sm-splash');
    if (!el) return;
    el.classList.add('fade');
    document.body.classList.remove('splash-active');
    updateShareVisibility();
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 450);
  }

  // ---------------- 탭 ----------------
  var TAB_CLASSES = ['tab-home', 'tab-records', 'tab-series', 'tab-my'];

  function setTab(name) {
    state.activeTab = name;
    $$('.sm-panel').forEach(function (p) {
      p.classList.toggle('active', p.getAttribute('data-tab') === name);
    });
    $$('.sm-tabbar .tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === name);
    });
    // body에 현재 탭 클래스 기록 (공유 버튼 등 전역 오버레이의 가시성 제어용)
    var body = document.body;
    TAB_CLASSES.forEach(function (c) { body.classList.remove(c); });
    body.classList.add('tab-' + name);
    updateShareVisibility();
  }

  function wireTabs() {
    $$('.sm-tabbar .tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setTab(btn.getAttribute('data-tab'));
      });
    });
  }

  // ---------------- 시리즈 탭 렌더 (카테고리별 그룹 + .sm-si 카드) ----------------
  // 데모용 활성 plan 목록 — 실제 결제 시스템 연결 시 동적으로 채움
  var ACTIVE_PLAN_IDS = ['color', 'easy', 'combining', 'verticaladd', 'minusone'];

  function renderSeries() {
    var host = $('#sm-series-sections');
    if (!host) return;
    host.innerHTML = '';
    window.SM_APPS_GROUPED().forEach(function (group) {
      if (!group.apps.length) return;
      var section = document.createElement('section');
      section.className = 'series-section';
      var title = document.createElement('div');
      title.className = 'cat-title';
      title.textContent = group.category;
      section.appendChild(title);
      if (group.description) {
        var desc = document.createElement('div');
        desc.className = 'cat-desc';
        desc.textContent = group.description;
        section.appendChild(desc);
      }
      var grid = document.createElement('div');
      grid.className = 'sm-sg';
      group.apps.forEach(function (app) {
        var cur = app.id === state.currentApp;
        var active = ACTIVE_PLAN_IDS.indexOf(app.id) >= 0;
        var card = document.createElement('button');
        card.type = 'button';
        card.className = 'sm-si' + (cur ? ' smc' : '');
        card.setAttribute('data-app', app.id);
        card.innerHTML =
          '<span class="sm-se">' + app.icon + '</span>' +
          '<span class="sm-sn">' + app.name + '</span>' +
          (active ? '<span class="sm-sb-active">이용중</span>' : '') +
          (cur ? '<span class="sm-sb">현재</span>' : '');
        card.addEventListener('click', function () { selectApp(app.id); });
        grid.appendChild(card);
      });
      section.appendChild(grid);
      host.appendChild(section);
    });
  }

  // ---------------- 홈 탭 (iframe 호스트) ----------------
  function selectApp(appId) {
    var app = window.SM_FIND_APP(appId);
    if (!app) return;
    state.currentApp = appId;

    var wrap = $('#home-iframe-wrap');
    var empty = $('#home-empty');
    if (empty) empty.style.display = 'none';
    if (wrap) wrap.style.display = 'block';

    // iframe 생성 또는 src 교체
    if (!state.iframeEl) {
      state.iframeEl = document.createElement('iframe');
      state.iframeEl.setAttribute('allow', 'autoplay; fullscreen');
      state.iframeEl.setAttribute('title', app.name);
      state.iframeEl.addEventListener('load', onIframeLoad);
      wrap.appendChild(state.iframeEl);
    } else {
      state.iframeEl.setAttribute('title', app.name);
    }
    state.iframeEl.src = window.SM_APP_PATH(appId);
    setTab('home');
    updateShareVisibility();
  }

  // iframe에 동기 적용되는 인라인 CSS (서브앱 내부 탭바/로그인/마이 UI 숨김).
  // 공유 버튼·버블은 서브앱 자체 구현을 사용하므로 여기서 숨기지 않음.
  var EMBEDDED_INLINE_CSS = [
    '.sm-tab-bar,.sm-tb,.sm-tabbar,.sm-bottom-tab,.sm-bottombar,#sm-tab-bar,#sm-tabbar,[id$="-tabbar"],[class*="tab-bar"],[class*="tabbar"]{display:none !important;}',
    /* 서브앱 로그인 뷰 숨김 — 쉘의 통합 로그인 뷰로 대체 */
    '#login-view,.login-view{display:none !important;}',
    '.sm-my,#sm-my,.sm-records,#sm-records,[class*="my-view"],[id*="my-view"]{display:none !important;}',
    '.logout-btn{display:none !important;}',
    /* 서브앱 공유 UI 숨김 — 쉘이 시리즈 탭에서 통합 관리 */
    '.share-btn,.share-bubble,#share-bubble,#share-toast,[title="공유하기"],[onclick*="shareApp"]{display:none !important;}',
    'body{padding-bottom:0 !important;}'
  ].join('');

  // iframe 내부의 "추천 팝업(바로 해보기)" 클릭을 쉘이 가로채 정상 selectApp 경로로 연결.
  // 그대로 두면 iframe이 외부 URL로 navigate해 쉘 상태가 어긋남.
  var RECO_INTERCEPT_SCRIPT = [
    '(function(){',
    '  function intercept(e){',
    '    var t=e.target; if(!t) return;',
    '    var el=t.closest?t.closest("#sm-reco-link,a[href*=\\"slowmath_\\"]"):null;',
    '    if(!el) return;',
    '    var href=el.getAttribute("href")||"";',
    '    var m=href.match(/slowmath_([a-z0-9]+)/);',
    '    if(!m) return;',
    '    e.preventDefault();',
    '    e.stopPropagation();',
    '    var ov=document.getElementById("sm-reco-overlay");',
    '    if(ov) ov.style.display="none";',
    '    try{ parent.postMessage({source:"sm-subapp",type:"reco-selected",payload:{appId:m[1]}},"*"); }catch(err){}',
    '  }',
    '  document.addEventListener("click", intercept, true);',
    '})();'
  ].join('');

  // iframe 내부에서 login-view 가시성을 감시해 parent에 알리는 스크립트.
  // MutationObserver + 클릭 리스너 + 500ms 인터벌 폴링 → 어떤 타이밍에서도 확실히 감지.
  var LOGIN_NOTIFIER_SCRIPT = [
    '(function(){',
    '  function find(){ return document.getElementById("login-view")||document.querySelector(".login-view"); }',
    '  var last=null;',
    '  function notify(visible){',
    '    try{ parent.postMessage({source:"sm-subapp",type:visible?"login-view-shown":"login-view-hidden"},"*"); }catch(e){}',
    '  }',
    '  function check(){',
    '    var lv=find(); if(!lv) return;',
    '    var classHidden=lv.classList.contains("hidden");',
    '    var styleHidden=(lv.style.display==="none");',
    '    var visible=!classHidden && !styleHidden;',
    '    if(visible===last) return;',
    '    last=visible;',
    '    notify(visible);',
    '  }',
    '  function attachMO(){',
    '    var lv=find(); if(!lv){ setTimeout(attachMO,100); return; }',
    '    try{ new MutationObserver(check).observe(lv,{attributes:true,attributeFilter:["class","style"]}); }catch(e){}',
    '  }',
    '  attachMO();',
    '  document.addEventListener("click", function(){ setTimeout(check,40); setTimeout(check,200); setTimeout(check,600); }, true);',
    '  setTimeout(check,100); setTimeout(check,500); setTimeout(check,1500);',
    '  setInterval(check, 500);', // 최종 보루
    '})();'
  ].join('');

  function onIframeLoad() {
    try {
      var doc = state.iframeEl.contentDocument;
      if (!doc) return;
      // iframe을 appendChild 하면 src 설정 전 about:blank에서 'load'가 먼저 발생.
      // 이 시점에 <link rel=stylesheet>를 상대경로로 주입하면 base URL이 없어 404 발생.
      // (실제 서브앱 로드 시 두 번째 load에서 다시 주입되므로 초기 load는 스킵)
      if (doc.location && doc.location.href === 'about:blank') return;

      // ① 인라인 <style> 동기 주입 (최우선)
      var prevInline = doc.getElementById('__sm_shell_embed_inline');
      if (prevInline) prevInline.parentNode.removeChild(prevInline);
      var styleTag = doc.createElement('style');
      styleTag.id = '__sm_shell_embed_inline';
      styleTag.textContent = EMBEDDED_INLINE_CSS;
      doc.head.appendChild(styleTag);

      // ② 외부 <link>도 유지 (미래 CSS 추가분용, 캐시버스팅 포함)
      var prev = doc.getElementById('__sm_shell_embed_css');
      if (prev) prev.parentNode.removeChild(prev);
      var link = doc.createElement('link');
      link.id = '__sm_shell_embed_css';
      link.rel = 'stylesheet';
      link.href = '../shell/embedded.css?v=6';
      doc.head.appendChild(link);

      // 쉘 상태 전달
      try {
        state.iframeEl.contentWindow.__SM_EMBED = {
          version: 1,
          flags: Object.assign({}, FLAGS)
        };
      } catch (e) { /* noop */ }

      // 새 로드마다 game-active 초기화 후 observer 재부착
      document.body.classList.remove('game-active');
      attachGameObserver(doc);
      // 서브앱 초기 화면을 start-view로 강제 (login-view 자동 노출 방지)
      forceStartViewInIframe(doc);
      attachLoginViewObserver(doc);
      // iframe 내부에 login-view 가시성 알림 스크립트 주입 (parent에 postMessage)
      try {
        var notifier = doc.createElement('script');
        notifier.textContent = LOGIN_NOTIFIER_SCRIPT;
        doc.head.appendChild(notifier);
      } catch (e) { /* noop */ }
      // iframe 내부 추천 팝업 "바로 해보기" 클릭 인터셉트 스크립트 주입
      try {
        var recoScript = doc.createElement('script');
        recoScript.textContent = RECO_INTERCEPT_SCRIPT;
        doc.head.appendChild(recoScript);
      } catch (e) { /* noop */ }
    } catch (e) {
      console.warn('[shell] iframe 주입 실패:', e && e.message);
    }
  }

  // ---------------- 게임 플레이 감지 (공유 버튼 숨김용) ----------------
  var GAME_VIEW_IDS = [
    'play-view','game-view','playView','gameView',
    'result-view','resultView','quiz-view','drag-view',
    'fill-view','wn-view','wrong-notes-view','wrongNotesView',
    'cv-play','cv-result'
  ];
  var _gameObservers = [];

  function isIframeGameVisible() {
    try {
      var doc = state.iframeEl && state.iframeEl.contentDocument;
      if (!doc) return false;
      var win = doc.defaultView || window;
      for (var i = 0; i < GAME_VIEW_IDS.length; i++) {
        var el = doc.getElementById(GAME_VIEW_IDS[i]);
        if (!el) continue;
        if (el.classList.contains('hidden') || el.classList.contains('smh')) continue;
        var cs = win.getComputedStyle(el);
        if (cs.display !== 'none' && cs.visibility !== 'hidden') return true;
      }
    } catch (e) { /* noop */ }
    return false;
  }

  function syncGameActive() {
    document.body.classList.toggle('game-active', isIframeGameVisible());
    updateShareVisibility();
  }

  function attachGameObserver(doc) {
    _gameObservers.forEach(function (o) { try { o.disconnect(); } catch (e) {} });
    _gameObservers = [];
    GAME_VIEW_IDS.forEach(function (id) {
      var el = doc.getElementById(id);
      if (!el) return;
      try {
        var o = new MutationObserver(syncGameActive);
        o.observe(el, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
        _gameObservers.push(o);
      } catch (e) { /* noop */ }
    });
    // iframe 내부 view 전환이 지연될 수 있으므로 초기·단기 폴링 한두 번
    syncGameActive();
    setTimeout(syncGameActive, 300);
    setTimeout(syncGameActive, 1500);
  }

  function wireHomeEmpty() {
    var btn = $('#home-goto-series');
    if (btn) btn.addEventListener('click', function () { setTab('series'); });
  }

  // ---------------- postMessage 브릿지 ----------------
  function sendToIframe(msg) {
    if (state.iframeEl && state.iframeEl.contentWindow) {
      try { state.iframeEl.contentWindow.postMessage(msg, '*'); } catch (e) { /* noop */ }
    }
  }

  function handleIframeMessage(ev) {
    // 서브앱 자체 메시지(임의 구조)와 충돌 피하려고 우리 스키마는 { source:'sm-subapp', type, payload }
    var data = ev.data;
    if (!data || data.source !== 'sm-subapp' || !data.type) return;

    switch (data.type) {
      case 'play-requested':
        state.pendingPlayRequest = data.payload || {};
        runPlayGate();
        break;
      case 'payment-required':
        showPaymentModal();
        break;
      case 'record-saved':
        saveRecord(data.payload || {});
        break;
      case 'login-view-shown':
        // iframe 내부가 login-view 노출 → 쉘의 통합 로그인 뷰 표시
        if (!isLoggedIn() && state.activeTab === 'home') showLoginView();
        break;
      case 'login-view-hidden':
        // iframe 내부 login-view 사라짐 (로그인 성공 등)
        if (state.activeTab === 'home') updateLoginViewVisibility();
        break;
      case 'reco-selected':
        // 추천 팝업에서 고른 앱으로 쉘이 정식 경로로 전환
        if (data.payload && data.payload.appId && window.SM_FIND_APP(data.payload.appId)) {
          selectApp(data.payload.appId);
        }
        break;
      default:
        // 알 수 없는 타입은 무시
        break;
    }
  }

  function runPlayGate() {
    // 인증은 풀스크린 로그인 뷰(updateLoginViewVisibility)가 처리하므로
    // 여기선 이용권 게이트만 평가
    if (FLAGS.ticket) {
      var tickets = lsGet(LS.tickets, null);
      if (!tickets || !tickets.active) { showPaymentModal(); return; }
    }
    sendToIframe({ source: 'sm-shell', type: 'play-allowed', payload: state.pendingPlayRequest });
    state.pendingPlayRequest = null;
  }

  // ---------------- 풀스크린 로그인 뷰 ----------------
  function showLoginView() {
    var v = $('#sm-login-view');
    if (v) v.style.display = 'flex';
  }
  function hideLoginView() {
    var v = $('#sm-login-view');
    if (v) v.style.display = 'none';
  }
  // 서브앱이 login-view를 "보이려고" 하는지 검사.
  // 서브앱마다 토글 방식이 다름:
  //   - 일부는 classList.add/remove('hidden')
  //   - 일부는 showView()에서 el.style.display = 'flex'/'none' 로 직접 설정
  // 인라인 style이 명시되면 class보다 우선 판정 (class 기반 선제 숨김이 오판하지 않도록).
  function isSubappLoginViewActive() {
    try {
      var doc = state.iframeEl && state.iframeEl.contentDocument;
      if (!doc) return false;
      var lv = doc.getElementById('login-view') || doc.querySelector('.login-view');
      if (!lv) return false;
      var sd = lv.style.display;
      if (sd && sd !== 'none' && sd !== '') return true;   // 서브앱이 명시적으로 노출 의도
      if (sd === 'none') return false;                      // 서브앱이 명시적으로 숨김
      if (lv.classList.contains('hidden')) return false;    // class 기반 숨김
      return true;                                           // 기본 노출 상태
    } catch (e) { return false; }
  }

  // 로그인 필요 조건:
  //   - 마이/기록 탭 활성 상태에서 로그아웃 상태, 또는
  //   - 연습(홈) 탭 활성 + 서브앱이 자체 login-view를 띄우려 하는데 로그아웃 상태
  function updateLoginViewVisibility() {
    if (isLoggedIn()) { hideLoginView(); return; }
    var onMyRec = (state.activeTab === 'my' || state.activeTab === 'records');
    var onHomeWithSubappLogin = (state.activeTab === 'home' && isSubappLoginViewActive());
    if (onMyRec || onHomeWithSubappLogin) showLoginView();
    else hideLoginView();
  }

  // iframe 로드 직후 서브앱의 초기 화면 전환을 강제로 start-view로 돌림.
  // (일부 서브앱은 로그아웃 상태면 init 단계에서 바로 login-view를 띄우는데,
  //  그대로 두면 관찰자가 감지해 쉘 로그인 뷰가 즉시 노출됨. 대신 사용자가
  //  "시작하기" 버튼을 눌러 startGame이 login-view로 전환할 때만 노출되게 함.)
  function forceStartViewInIframe(doc) {
    try {
      // login-view는 'hidden'만 추가 (서브앱이 startGame 시 'hidden'만 제거하므로
      //  우리도 'hidden'만 관리해야 감지 로직이 일관됨)
      var lv = doc.getElementById('login-view') || doc.querySelector('.login-view');
      if (lv) lv.classList.add('hidden');

      // 서브앱마다 시작 화면 id가 다름 — 후보 전수 시도
      var candidates = ['start-view', 'home-view', 'startView', 'homeView', 'start-screen', 'home-screen'];
      for (var i = 0; i < candidates.length; i++) {
        var sv = doc.getElementById(candidates[i]);
        if (sv) {
          sv.classList.remove('hidden');
          sv.classList.remove('smh');
          if (sv.style.display === 'none') sv.style.display = '';
          break;
        }
      }
    } catch (e) { /* noop */ }
  }

  // iframe 내 login-view 엘리먼트에 MutationObserver 부착 + 클릭 이벤트 fallback.
  // 서브앱마다 showView/classList 조작 방식이 달라 MutationObserver가 놓치는 케이스가 있음
  // → iframe 내부의 모든 클릭 뒤 짧은 지연으로 강제 재평가해 확실히 잡음.
  var _subappLoginObserver = null;
  var _subappClickListener = null;
  var _subappClickDoc = null;
  function attachLoginViewObserver(doc) {
    try {
      if (_subappLoginObserver) { _subappLoginObserver.disconnect(); _subappLoginObserver = null; }
      if (_subappClickListener && _subappClickDoc) {
        try { _subappClickDoc.removeEventListener('click', _subappClickListener, true); } catch (e) {}
      }
      var lv = doc.getElementById('login-view') || doc.querySelector('.login-view');
      if (!lv) return;
      _subappLoginObserver = new MutationObserver(updateLoginViewVisibility);
      _subappLoginObserver.observe(lv, { attributes: true, attributeFilter: ['class', 'style'] });

      // 클릭 후 50/250ms 두 번 재평가 — "시작하기" 등의 전환 직후 login-view 가시성 변경 캐치
      _subappClickListener = function () {
        setTimeout(updateLoginViewVisibility, 50);
        setTimeout(updateLoginViewVisibility, 250);
      };
      _subappClickDoc = doc;
      doc.addEventListener('click', _subappClickListener, true);

      // 초기 1회 + 서브앱 초기화 늦어지는 케이스 대비 단기 폴링
      updateLoginViewVisibility();
      setTimeout(updateLoginViewVisibility, 300);
      setTimeout(updateLoginViewVisibility, 1500);
    } catch (e) { /* noop */ }
  }

  function doShellLogin(provider) {
    var info = {
      id: 'demo',
      name: '사용자',
      email: 'sprit6487@gmail.com',
      provider: provider || 'kakao',
      at: Date.now()
    };
    lsSet(LS.user, info);
    propagateSubappLogin(info);  // 모든 서브앱의 로그인 키 일괄 세팅

    // iframe이 로드되어 있으면 서브앱 로그인 함수 호출 — _sp(대기 중 게임모드) 복원 포함.
    // 서브앱마다 함수 이름이 다름: socialLogin (17개) / doLogin (5개 — colorcopy, combining,
    // complement, pattern, splitting). 둘 다 시도.
    try {
      var win = state.iframeEl && state.iframeEl.contentWindow;
      if (win) {
        var called = false;
        if (typeof win.socialLogin === 'function') {
          win.socialLogin(provider || 'kakao');
          called = true;
        }
        if (!called && typeof win.doLogin === 'function') {
          win.doLogin(provider || 'kakao');
          called = true;
        }
        // 혹시 두 함수 다 없으면 직접 _sp 복원 시도 (마지막 안전장치)
        if (!called) {
          try {
            var ss = win.sessionStorage;
            var sp = ss && ss.getItem('_sp');
            if (sp && typeof win.startGame === 'function') {
              ss.removeItem('_sp');
              var args = JSON.parse(sp);
              win.startGame.apply(null, Array.isArray(args) ? args : [args]);
            }
          } catch (e2) { /* noop */ }
        }
      }
    } catch (e) { /* noop */ }

    hideLoginView();
    renderMy();
  }

  // ---------------- 모달 (placeholder) ----------------
  // 로그인 모달의 약관 동의는 카카오/구글 OAuth 동의 화면에 위임 — 자체 체크박스 없음
  function resetPayAgree() {
    var cb = document.getElementById('sm-pay-agree');
    if (cb) cb.checked = false;
    updatePayOkEnabled();
  }
  function updatePayOkEnabled() {
    var ok = document.getElementById('sm-pay-ok');
    if (!ok) return;
    var cb = document.getElementById('sm-pay-agree');
    ok.disabled = !(cb && cb.checked);
  }
  function showPaymentModal() {
    var mask = $('#sm-modal-payment');
    if (mask) mask.classList.add('show');
    resetPayAgree();
  }
  function hidePaymentModal() {
    var mask = $('#sm-modal-payment');
    if (mask) mask.classList.remove('show');
  }

  // ---------------- 약관/처리방침 풀스크린 오버레이 ----------------
  // 약관 본문 HTML — legal/terms-of-service.md를 수동 변환한 결과.
  // 약관이 수정되면 legal/terms-of-service.md를 갱신한 뒤 아래 문자열도 함께 갱신해야 함.
  var LEGAL_DOCS = {
    terms: {
      title: '이용약관',
      html: [
        '<h1>느린아이 서비스 이용약관</h1>',
        '<div class="sm-legal-meta"><b>시행일</b>: 2026-04-28<br><b>최종 개정일</b>: 2026-04-28</div>',
        '<hr>',
        '<h2>제1조 (목적)</h2>',
        '<p>본 약관은 「느린아이」(이하 "회사")가 운영하는 학습 서비스 「느린아이」(이하 "서비스")를 이용함에 있어 회사와 회원 사이의 권리·의무 및 책임 사항, 기타 필요한 사항을 규정함을 목적으로 합니다.</p>',
        '<h2>제2조 (용어의 정의)</h2>',
        '<p>본 약관에서 사용하는 용어의 정의는 다음과 같습니다.</p>',
        '<ol>',
        '<li><strong>서비스</strong>: 회사가 「느린아이」라는 명칭으로 모바일 앱(Android·iOS) 및 웹을 통해 제공하는 교육 콘텐츠 일체를 말합니다.</li>',
        '<li><strong>회원</strong>: 회사와 이용계약을 체결하고 서비스를 이용하는 개인 또는 그 보호자를 말합니다.</li>',
        '<li><strong>이용자</strong>: 회원으로 가입한 사람과 그가 사용하도록 허락한 자녀(미성년자)를 포함합니다.</li>',
        '<li><strong>이용권</strong>: 일정 기간 서비스 또는 특정 학습 콘텐츠를 이용할 수 있는 유료 권한을 말합니다.</li>',
        '<li><strong>무료 이용권</strong>: 가입 직후 일정 기간(회원가입 후 24시간) 또는 이벤트·공유를 통해 회원에게 제공되는 한시적 무상 이용 권한을 말합니다.</li>',
        '<li><strong>인앱결제(IAP)</strong>: Google Play 결제 시스템 또는 Apple App Store 결제 시스템을 통해 이루어지는 콘텐츠 구매를 말합니다.</li>',
        '</ol>',
        '<h2>제3조 (약관의 게시와 개정)</h2>',
        '<ol>',
        '<li>회사는 본 약관의 내용을 회원이 쉽게 알 수 있도록 서비스 초기 화면 및 설정 메뉴에 게시합니다.</li>',
        '<li>회사는 「약관의 규제에 관한 법률」, 「전자상거래 등에서의 소비자보호에 관한 법률」, 「콘텐츠산업 진흥법」 등 관련 법령을 위배하지 않는 범위에서 본 약관을 개정할 수 있습니다.</li>',
        '<li>약관을 개정할 경우 회사는 적용일자 및 개정 사유를 명시하여 적용일자 7일 전부터 서비스 내 공지합니다. 다만 회원에게 불리하게 개정하는 경우에는 적용일자 30일 전부터 공지하고, 회원이 사용하는 이메일·앱 푸시 등으로 별도 통지합니다.</li>',
        '<li>회원이 개정 약관에 동의하지 않을 경우 이용계약을 해지할 수 있으며, 적용일자 이후에도 서비스를 계속 이용한 경우에는 개정 약관에 동의한 것으로 봅니다.</li>',
        '</ol>',
        '<h2>제4조 (이용계약의 체결)</h2>',
        '<ol>',
        '<li>이용계약은 이용자가 본 약관 및 개인정보 처리방침에 동의하고 회사가 정한 절차에 따라 회원가입을 완료한 시점에 체결됩니다.</li>',
        '<li>회사는 다음 각 호에 해당하는 신청에 대해서는 승낙을 거부하거나 사후에 이용계약을 해지할 수 있습니다.<ul>',
        '<li>타인의 명의를 도용한 경우</li>',
        '<li>허위 정보를 기재한 경우</li>',
        '<li>사회 질서 또는 미풍양속을 저해할 목적으로 신청한 경우</li>',
        '<li>기타 회사가 정한 이용신청 요건을 충족하지 못한 경우</li>',
        '</ul></li>',
        '<li><strong>미성년자의 이용</strong>: 만 14세 미만의 아동은 법정대리인(부모 등 보호자)의 동의를 받아 회원가입할 수 있으며, 결제 행위는 반드시 법정대리인의 명의 또는 동의 하에 이루어져야 합니다.</li>',
        '</ol>',
        '<h2>제5조 (회원의 의무)</h2>',
        '<ol>',
        '<li>회원은 본 약관, 회사의 공지사항, 관계 법령을 준수해야 합니다.</li>',
        '<li>회원은 자신의 계정 정보(이메일, 비밀번호, OAuth 연동 계정 등)를 제3자에게 공개·양도하거나 대여해서는 안 됩니다.</li>',
        '<li>회원은 다음 행위를 해서는 안 됩니다.<ul>',
        '<li>서비스를 영리 목적으로 이용하거나 콘텐츠를 무단 복제·배포하는 행위</li>',
        '<li>서비스 운영을 방해하는 행위(자동화 도구·봇·역공학 시도 등)</li>',
        '<li>다른 회원의 개인정보를 수집·저장·공개하는 행위</li>',
        '<li>회사 또는 제3자의 지적재산권을 침해하는 행위</li>',
        '</ul></li>',
        '</ol>',
        '<h2>제6조 (서비스의 제공)</h2>',
        '<ol>',
        '<li>회사는 다음과 같은 서비스를 제공합니다.<ul>',
        '<li>단계별 학습 콘텐츠 (수 개념·연산 등)</li>',
        '<li>학습 진도·결과 기록 및 통계</li>',
        '<li>그 밖에 회사가 정하는 부가 서비스</li>',
        '</ul></li>',
        '<li>서비스는 연중무휴, 1일 24시간 제공함을 원칙으로 합니다. 다만 정기 점검·시스템 장애·천재지변 등의 사유로 일시 중단될 수 있으며, 이 경우 회사는 사전에 공지합니다.</li>',
        '<li>회사는 서비스의 일부 또는 전부를 변경·중단할 수 있으며, 변경·중단 시에는 사전에 공지합니다.</li>',
        '</ol>',
        '<h2>제7조 (이용권 및 결제)</h2>',
        '<h3>7.1 이용권의 종류</h3>',
        '<ol>',
        '<li><strong>무료 이용권</strong><ul>',
        '<li>회원가입 후 24시간 동안 서비스 전체를 무상으로 이용할 수 있습니다.</li>',
        '<li>회사가 별도로 발급하는 이벤트·공유 보상 쿠폰을 통해 한시적 무상 이용이 가능합니다.</li>',
        '</ul></li>',
        '<li><strong>유료 이용권 (30일 이용권)</strong><ul>',
        '<li>가격: 부가세 포함 ₩2,200원 (인앱결제 스토어 환율·정책에 따라 표시 가격은 일부 다를 수 있음)</li>',
        '<li>기간: 결제 완료 시점부터 30일간 해당 학습 콘텐츠 이용 가능</li>',
        '<li>결제 수단: Google Play 결제 시스템(Android) 또는 Apple App Store 결제 시스템(iOS)을 통한 1회성 인앱결제</li>',
        '</ul></li>',
        '</ol>',
        '<h3>7.2 결제 절차</h3>',
        '<ol>',
        '<li>회원이 서비스 내에서 이용권 구매를 선택하면 Google Play 또는 Apple App Store의 결제 시스템으로 연결됩니다.</li>',
        '<li>결제는 각 스토어의 정책 및 결제 수단(신용카드, 휴대폰 결제, 기프트 카드 등)에 따라 진행되며, 결제 완료 시점에 이용권이 즉시 활성화됩니다.</li>',
        '<li>결제 영수증 및 거래 증빙은 각 스토어를 통해 발급되며, 회원은 스토어의 구매 내역에서 확인할 수 있습니다.</li>',
        '</ol>',
        '<h2>제8조 (청약 철회 및 환불)</h2>',
        '<h3>8.1 청약 철회의 원칙</h3>',
        '<p>「전자상거래 등에서의 소비자보호에 관한 법률」 및 「콘텐츠산업 진흥법」에 따라 회원은 다음과 같이 청약 철회 및 환불을 요청할 수 있습니다.</p>',
        '<ol>',
        '<li><strong>결제 후 7일 이내, 콘텐츠 미사용 시</strong>: 전액 환불</li>',
        '<li><strong>결제 후 7일 이내, 콘텐츠 일부 사용 시</strong>: 같은 법 제17조 제2항 제5호에 따라 가분(可分)되지 않는 디지털 콘텐츠로서 사용·이용으로 가치가 현저히 감소한 경우 환불이 제한될 수 있습니다. 다만 회사는 사용자 보호를 위해 다음 기준을 적용합니다.<ul>',
        '<li>결제 후 7일 이내 + 누적 이용 기록이 1일 미만인 경우 → 전액 환불</li>',
        '<li>결제 후 7일 이내 + 누적 이용 기록이 1일 이상인 경우 → 환불 제한</li>',
        '</ul></li>',
        '<li><strong>결제 후 7일 이후</strong>: 회사 귀책 사유(서비스 장애로 7일 이상 이용 불가 등)가 있는 경우를 제외하고 환불 제한</li>',
        '</ol>',
        '<h3>8.2 환불 절차</h3>',
        '<ol>',
        '<li><strong>인앱결제 환불 신청 경로</strong><ul>',
        '<li><strong>Android (Google Play)</strong>: 본 약관에 따른 환불 요건을 충족하는 경우, 회원은 Google Play의 환불 정책에 따라 직접 또는 회사를 통해 환불 신청할 수 있습니다.</li>',
        '<li><strong>iOS (Apple App Store)</strong>: Apple의 환불 정책에 따라 reportaproblem.apple.com 또는 회사를 통해 환불 신청할 수 있습니다.</li>',
        '</ul></li>',
        '<li><strong>회사를 통한 신청</strong>: 회원은 아래 고객센터 이메일로 결제 영수증, 회원 식별 정보(이메일 또는 회원 ID)를 첨부하여 환불을 요청할 수 있습니다. 회사는 7영업일 이내 검토 후 결과를 회신합니다.</li>',
        '<li><strong>환불 처리 기한</strong>: 환불 승인 후 실제 결제 수단으로의 환급은 각 스토어 및 카드사·통신사의 처리 기간(통상 3~14영업일)에 따릅니다.</li>',
        '</ol>',
        '<h3>8.3 환불이 제한되는 경우</h3>',
        '<p>다음 각 호의 경우에는 환불이 제한될 수 있습니다.</p>',
        '<ol>',
        '<li>회원의 약관 위반(부정 사용·계정 공유 등)으로 이용권이 회수된 경우</li>',
        '<li>회원이 청약 철회 가능 기간(결제일로부터 7일)을 경과한 경우 (단, 회사 귀책 사유 제외)</li>',
        '<li>무상 제공된 이용권(무료 이용권·이벤트 쿠폰)을 사용한 경우</li>',
        '<li>사용자 본인의 단순 변심으로 콘텐츠를 1일 이상 이용한 경우 (제8.1조 제2항 적용)</li>',
        '</ol>',
        '<h3>8.4 미성년자 결제</h3>',
        '<p>만 19세 미만 미성년자가 법정대리인의 동의 없이 결제한 경우, 본인 또는 법정대리인은 결제 사실을 안 날로부터 합리적 기간 내에 결제 취소 및 환불을 요청할 수 있습니다. 회사는 「민법」 제5조에 따라 법정대리인의 동의 여부를 확인한 후 환불 처리합니다.</p>',
        '<h2>제9조 (이용계약의 해지)</h2>',
        '<ol>',
        '<li><strong>회원의 해지</strong>: 회원은 언제든지 서비스 내 설정 메뉴를 통해 이용계약 해지(회원 탈퇴)를 요청할 수 있습니다. 해지 시 보유 중인 잔여 이용권은 본 약관 제8조에 따라 처리됩니다.</li>',
        '<li><strong>회사의 해지</strong>: 회사는 회원이 본 약관 제5조의 의무를 중대하게 위반한 경우 사전 통지 후 이용계약을 해지할 수 있습니다. 다만 위반의 경중 및 회복 가능성에 따라 일시 이용 정지로 갈음할 수 있습니다.</li>',
        '<li>이용계약 해지 시 회원이 작성한 학습 기록·통계 등은 개인정보 처리방침에 따라 처리됩니다.</li>',
        '</ol>',
        '<h2>제10조 (개인정보 보호)</h2>',
        '<p>회사는 관계 법령에 따라 회원의 개인정보를 보호하기 위해 노력하며, 자세한 내용은 별도의 「개인정보 처리방침」에 따릅니다.</p>',
        '<h2>제11조 (지적재산권)</h2>',
        '<ol>',
        '<li>서비스 내 모든 콘텐츠(텍스트, 이미지, 음원, 코드, 디자인 등)에 대한 저작권 및 지적재산권은 회사 또는 정당한 권리자에게 있습니다.</li>',
        '<li>회원은 서비스를 이용함으로써 얻은 정보 중 회사 또는 제공자에게 지적재산권이 귀속된 정보를 회사 또는 제공자의 사전 승낙 없이 복제·전송·출판·배포·방송하거나 제3자에게 이용하게 해서는 안 됩니다.</li>',
        '</ol>',
        '<h2>제12조 (면책 조항)</h2>',
        '<ol>',
        '<li>회사는 천재지변, 전쟁, 통신 두절, 정전, 해킹 등 불가항력으로 인하여 서비스를 제공할 수 없는 경우 책임을 지지 않습니다.</li>',
        '<li>회사는 회원의 귀책 사유로 인한 서비스 이용 장애에 대하여 책임을 지지 않습니다.</li>',
        '<li>회사는 학습 결과 또는 콘텐츠의 효과·진단·치료적 효능을 보장하지 않으며, 본 서비스는 의료적 진단·치료를 대체할 수 없습니다. 발달 진단·치료가 필요한 경우 의료 전문가의 상담을 권장합니다.</li>',
        '</ol>',
        '<h2>제13조 (분쟁 해결 및 관할 법원)</h2>',
        '<ol>',
        '<li>회사와 회원 사이에 발생한 분쟁은 양 당사자의 협의로 해결함을 원칙으로 합니다.</li>',
        '<li>협의가 이루어지지 않을 경우, 「전자상거래 등에서의 소비자보호에 관한 법률」 등 관계 법령에 따라 한국소비자원·전자거래분쟁조정위원회 등에 분쟁 조정을 신청할 수 있습니다.</li>',
        '<li>본 약관 및 서비스 이용과 관련하여 소송이 제기될 경우 「민사소송법」에 따른 관할 법원을 1심 관할 법원으로 합니다.</li>',
        '</ol>',
        '<h2>제14조 (고객센터 안내)</h2>',
        '<ul>',
        '<li><strong>운영자</strong>: 주식회사 에브리데이썸머 / 오홍석</li>',
        '<li><strong>이메일</strong>: contact@everydaysummer.net</li>',
        '<li><strong>사업자등록번호</strong>: 847-87-03993</li>',
        '<li><strong>주소</strong>: 서울특별시 관악구 남부순환로 1808, 15층 1505호</li>',
        '</ul>',
        '<p>서비스 관련 문의·환불 신청은 위 이메일로 접수해주시면 7영업일 이내 회신드립니다.</p>',
        '<h2>부칙</h2>',
        '<p>본 약관은 2026-04-28부터 시행합니다.</p>'
      ].join('')
    },
    privacy: {
      title: '개인정보 처리방침',
      // legal/privacy-policy.md를 수동 변환한 HTML.
      // 처리방침이 수정되면 .md 갱신과 함께 아래 문자열도 함께 갱신.
      html: [
        '<h1>느린아이 개인정보 처리방침</h1>',
        '<div class="sm-legal-meta"><b>시행일</b>: 2026-04-28<br><b>최종 개정일</b>: 2026-04-28</div>',
        '<hr>',
        '<p>주식회사 에브리데이썸머(이하 "회사")는 「개인정보 보호법」 제30조에 따라 정보주체의 개인정보를 보호하고, 이와 관련한 고충을 신속하고 원활하게 처리할 수 있도록 하기 위하여 다음과 같이 개인정보 처리방침을 수립·공개합니다.</p>',

        '<h2>제1조 (개인정보의 처리 목적)</h2>',
        '<p>회사는 다음의 목적을 위하여 개인정보를 처리합니다. 처리한 개인정보는 다음의 목적 이외의 용도로는 이용하지 않으며, 이용 목적이 변경되는 경우에는 별도의 동의를 받는 등 필요한 조치를 이행합니다.</p>',
        '<ol>',
        '<li><strong>회원 가입 및 관리</strong>: 회원 가입 의사 확인, 본인 식별, 회원자격 유지·관리</li>',
        '<li><strong>서비스 제공</strong>: 학습 콘텐츠 제공, 학습 기록 저장 및 통계 표시</li>',
        '<li><strong>고객 지원</strong>: 문의 사항 응대, 환불 처리, 공지사항 전달</li>',
        '<li><strong>부정 이용 방지</strong>: 약관 위반 회원에 대한 이용 제한 조치</li>',
        '</ol>',

        '<h2>제2조 (처리하는 개인정보 항목)</h2>',
        '<p>회사는 다음의 개인정보 항목을 처리합니다.</p>',
        '<h3>2.1 회원 가입 시 수집</h3>',
        '<ul>',
        '<li>필수 — <strong>이메일 주소</strong> (카카오 로그인 또는 Google 로그인 시 OAuth를 통해 자동 전달)</li>',
        '</ul>',
        '<p>회사는 위 이메일 주소 외에 이름·생년월일·전화번호 등 <strong>추가적인 개인 식별 정보를 직접 수집하지 않습니다.</strong></p>',
        '<h3>2.2 서비스 이용 과정에서 자동 수집</h3>',
        '<ul>',
        '<li>접속 IP 주소, 쿠키, 접속 일시 — 부정 이용 방지</li>',
        '<li>디바이스 식별 정보(OS, 앱 버전, 기기 모델) — 호환성 확인·디버깅</li>',
        '<li>학습 기록(연습 결과, 정답률, 학습 시간) — 회원 식별자(이메일)와 연결되어 저장</li>',
        '</ul>',
        '<h3>2.3 결제 정보 (별도)</h3>',
        '<p>인앱결제는 <strong>Google Play 결제 시스템(Android)</strong> 또는 <strong>Apple App Store 결제 시스템(iOS)</strong>이 직접 처리하며, 회사는 카드 번호·계좌 번호 등 결제 수단 정보를 수집·보유하지 않습니다. 회사는 결제 검증을 위해 각 스토어가 발급한 <strong>구매 ID(Order ID)</strong>와 <strong>영수증 토큰</strong>만 수신·보관합니다.</p>',

        '<h2>제3조 (개인정보의 처리 및 보유 기간)</h2>',
        '<p>회사는 법령에 따른 개인정보 보유·이용기간 또는 정보주체로부터 동의 받은 개인정보 보유·이용기간 내에서 개인정보를 처리·보유합니다.</p>',
        '<ul>',
        '<li><strong>회원 정보(이메일)</strong>: 회원 탈퇴 시까지 (정보주체 동의)</li>',
        '<li><strong>학습 기록</strong>: 회원 탈퇴 시까지 (서비스 제공 목적)</li>',
        '<li><strong>부정 이용 기록</strong>: 1년 (부정 이용 방지)</li>',
        '<li><strong>결제·환불 기록</strong>: 5년 (전자상거래법)</li>',
        '<li><strong>접속 로그·IP</strong>: 3개월 (통신비밀보호법)</li>',
        '</ul>',
        '<p>회원 탈퇴 시 위의 법령상 보존 의무 항목을 제외한 모든 개인정보는 <strong>지체 없이 파기</strong>됩니다.</p>',

        '<h2>제4조 (개인정보의 제3자 제공)</h2>',
        '<p>회사는 정보주체의 개인정보를 제1조의 처리 목적 범위 내에서만 처리하며, 정보주체의 사전 동의 없이는 본래 범위를 초과하여 처리하거나 제3자에게 제공하지 않습니다.</p>',
        '<p>다만, 다음의 경우는 예외로 합니다.</p>',
        '<ol>',
        '<li>정보주체로부터 별도의 동의를 받은 경우</li>',
        '<li>법령에 특별한 규정이 있는 경우</li>',
        '<li>수사기관·감독기관이 법령에 따른 절차와 방법에 따라 요청한 경우</li>',
        '</ol>',

        '<h2>제5조 (개인정보 처리의 위탁)</h2>',
        '<p>회사는 원활한 서비스 제공을 위하여 다음과 같이 개인정보 처리 업무를 위탁하고 있습니다.</p>',
        '<ul>',
        '<li><strong>Google LLC</strong> — 클라우드 인프라(서버 호스팅), TTS(음성 합성), OAuth 로그인 / 위탁 정보: 이메일, 학습 기록, 음성 합성 요청 텍스트</li>',
        '<li><strong>Kakao Corp.</strong> — OAuth 로그인 / 위탁 정보: 이메일</li>',
        '<li><strong>Apple Inc. / Google LLC</strong> — 인앱결제, 앱 배포 / 위탁 정보: 결제 영수증·구매 ID</li>',
        '<li><strong>Vercel Inc.</strong> — 웹 호스팅 / 위탁 정보: 접속 로그, IP</li>',
        '</ul>',
        '<p>회사는 위탁계약 체결 시 「개인정보 보호법」 제26조에 따라 위탁업무 수행 목적 외 개인정보 처리 금지, 기술적·관리적 보호조치, 재위탁 제한, 수탁자에 대한 관리·감독 등을 계약서에 명시하고, 수탁자가 개인정보를 안전하게 처리하는지 감독하고 있습니다.</p>',

        '<h2>제6조 (정보주체와 법정대리인의 권리·의무 및 행사 방법)</h2>',
        '<ol>',
        '<li>정보주체는 회사에 대해 언제든지 다음 각 호의 개인정보 보호 관련 권리를 행사할 수 있습니다.',
        '<ul>',
        '<li>개인정보 열람 요구</li>',
        '<li>오류 등이 있을 경우 정정 요구</li>',
        '<li>삭제 요구</li>',
        '<li>처리 정지 요구</li>',
        '</ul>',
        '</li>',
        '<li>위의 권리 행사는 회사에 대해 서면, 이메일 등을 통하여 하실 수 있으며 회사는 이에 대해 지체 없이 조치하겠습니다.</li>',
        '<li><strong>만 14세 미만 아동의 개인정보</strong>: 만 14세 미만 아동의 회원 가입 및 결제는 반드시 <strong>법정대리인의 동의</strong> 하에 이루어져야 하며, 법정대리인은 아동의 개인정보 열람·정정·삭제·처리정지를 요구할 권리가 있습니다.</li>',
        '</ol>',

        '<h2>제7조 (개인정보의 파기 절차 및 방법)</h2>',
        '<ol>',
        '<li>회사는 개인정보 보유기간의 경과, 처리목적 달성 등 개인정보가 불필요하게 되었을 때에는 지체 없이 해당 개인정보를 파기합니다.</li>',
        '<li><strong>파기 절차</strong>: 회원 탈퇴 또는 보유기간 경과 시 자동 또는 담당자에 의해 즉시 파기됩니다.</li>',
        '<li><strong>파기 방법</strong>: 전자적 파일 형태는 복구·재생할 수 없도록 영구 삭제하며, 종이 문서는 분쇄기로 분쇄하거나 소각합니다.</li>',
        '</ol>',

        '<h2>제8조 (개인정보의 안전성 확보 조치)</h2>',
        '<p>회사는 개인정보의 안전성 확보를 위해 다음과 같은 조치를 취하고 있습니다.</p>',
        '<ol>',
        '<li><strong>관리적 조치</strong>: 개인정보 취급자 최소화·교육</li>',
        '<li><strong>기술적 조치</strong>: 비밀번호·접속기록의 암호화, 보안 프로그램 설치, HTTPS 통신</li>',
        '<li><strong>물리적 조치</strong>: 데이터 센터·자료보관실 등의 접근통제</li>',
        '</ol>',

        '<h2>제9조 (개인정보 자동 수집 장치의 설치·운영 및 거부)</h2>',
        '<ol>',
        '<li>회사는 회원에게 맞춤형 서비스를 제공하기 위해 쿠키(cookie) 및 로컬 스토리지(localStorage)를 사용합니다.</li>',
        '<li><strong>사용 목적</strong>: 로그인 상태 유지, 학습 진도 저장, 서비스 이용 분석</li>',
        '<li><strong>거부 방법</strong>: 회원은 사용 중인 브라우저의 옵션 설정에서 쿠키 저장을 거부할 수 있습니다. 다만 거부 시 로그인 유지·학습 기록 저장 등 일부 서비스 이용에 제약이 있을 수 있습니다.</li>',
        '</ol>',

        '<h2>제10조 (개인정보 보호책임자)</h2>',
        '<p>회사는 개인정보 처리에 관한 업무를 총괄하여 책임지고, 개인정보 처리와 관련한 정보주체의 불만 처리 및 피해 구제 등을 위하여 아래와 같이 개인정보 보호책임자를 지정하고 있습니다.</p>',
        '<ul>',
        '<li><strong>개인정보 보호책임자</strong>: 오홍석</li>',
        '<li><strong>이메일</strong>: contact@everydaysummer.net</li>',
        '</ul>',
        '<p>정보주체는 회사의 서비스를 이용하시면서 발생한 모든 개인정보 보호 관련 문의·불만처리·피해구제 등에 관한 사항을 위 연락처로 문의하실 수 있으며, 회사는 정보주체의 문의에 지체 없이 답변 및 처리해드릴 것입니다.</p>',

        '<h2>제11조 (권익침해 구제 방법)</h2>',
        '<p>정보주체는 개인정보 침해로 인한 구제를 받기 위하여 아래 기관에 분쟁해결이나 상담 등을 신청할 수 있습니다.</p>',
        '<ul>',
        '<li><strong>개인정보분쟁조정위원회</strong>: (국번없이) 1833-6972 / www.kopico.go.kr</li>',
        '<li><strong>개인정보침해신고센터</strong>: (국번없이) 118 / privacy.kisa.or.kr</li>',
        '<li><strong>대검찰청</strong>: (국번없이) 1301 / www.spo.go.kr</li>',
        '<li><strong>경찰청</strong>: (국번없이) 182 / ecrm.cyber.go.kr</li>',
        '</ul>',

        '<h2>제12조 (개인정보 처리방침의 변경)</h2>',
        '<p>본 개인정보 처리방침은 시행일로부터 적용되며, 법령 및 방침에 따른 변경 내용의 추가·삭제 및 정정이 있는 경우에는 변경사항의 시행 7일 전부터 공지사항을 통하여 고지합니다. 다만 정보주체의 권리에 중요한 변경이 있을 경우에는 적용일자 30일 전부터 공지하고, 회원이 사용하는 이메일·앱 푸시 등으로 별도 통지합니다.</p>',

        '<h2>부칙</h2>',
        '<p>본 개인정보 처리방침은 2026-04-28부터 시행합니다.</p>',
        '<hr>',
        '<p><strong>운영자</strong>: 주식회사 에브리데이썸머 / 오홍석<br>',
        '<strong>이메일</strong>: contact@everydaysummer.net<br>',
        '<strong>사업자등록번호</strong>: 847-87-03993<br>',
        '<strong>주소</strong>: 서울특별시 관악구 남부순환로 1808, 15층 1505호</p>'
      ].join('')
    }
  };

  function openLegalDoc(docKey) {
    var doc = LEGAL_DOCS[docKey];
    if (!doc) return;
    var titleEl = document.getElementById('sm-legal-title');
    var bodyEl = document.getElementById('sm-legal-body');
    var overlay = document.getElementById('sm-legal-overlay');
    if (!titleEl || !bodyEl || !overlay) return;
    titleEl.textContent = doc.title;
    bodyEl.innerHTML = doc.html;
    overlay.hidden = false;
    bodyEl.scrollTop = 0;
  }

  function closeLegalDoc() {
    var overlay = document.getElementById('sm-legal-overlay');
    if (overlay) overlay.hidden = true;
  }

  // 서브앱 iframe(같은 origin)에서 window.parent.openLegalDoc(...) 으로
  // 호출할 수 있도록 전역 노출
  window.openLegalDoc = openLegalDoc;
  window.closeLegalDoc = closeLegalDoc;

  function wireLegalOverlay() {
    var back = document.getElementById('sm-legal-back');
    if (back) back.addEventListener('click', closeLegalDoc);

    // 마이 탭 정보 섹션 링크 (이용약관/처리방침)
    var links = document.querySelectorAll('.sm-my-link[data-doc]');
    Array.prototype.forEach.call(links, function (el) {
      el.addEventListener('click', function () {
        openLegalDoc(el.getAttribute('data-doc'));
      });
    });

    // 모달 안 "보기" 버튼 — 클릭 시 label의 토글이 일어나지 않도록 stopPropagation/preventDefault
    var viewBtns = document.querySelectorAll('.sm-agree-view[data-doc]');
    Array.prototype.forEach.call(viewBtns, function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openLegalDoc(el.getAttribute('data-doc'));
      });
    });

    // 풀스크린 로그인 뷰의 약관/처리방침 inline 링크
    var loginDocLinks = document.querySelectorAll('.sm-login-doc-link[data-doc]');
    Array.prototype.forEach.call(loginDocLinks, function (el) {
      el.addEventListener('click', function () {
        openLegalDoc(el.getAttribute('data-doc'));
      });
    });

    // 이용권/쿠폰 이용 내역 오버레이 닫기 (공용)
    var historyBack = document.getElementById('sm-history-back');
    if (historyBack) historyBack.addEventListener('click', closeHistoryOverlay);
  }

  function wireModals() {
    // 로그인 모달은 제거됨 — 풀스크린 로그인 뷰(#sm-login-view)가 모든 인증 흐름 처리

    // 결제 모달 약관 동의 체크박스
    var payAgree = document.getElementById('sm-pay-agree');
    if (payAgree) payAgree.addEventListener('change', updatePayOkEnabled);

    // 결제 모달 — MVP: "구매(가짜)" 버튼으로 이용권 활성화
    var payOk = $('#sm-pay-ok');
    if (payOk) payOk.addEventListener('click', function () {
      if (payOk.disabled) return;
      lsSet(LS.tickets, { active: true, kind: 'demo', at: Date.now() });
      hidePaymentModal();
      renderMy();
      if (state.pendingPlayRequest) runPlayGate();
    });
    var payCancel = $('#sm-pay-cancel');
    if (payCancel) payCancel.addEventListener('click', function () {
      hidePaymentModal();
      state.pendingPlayRequest = null;
    });

    wireLegalOverlay();
  }

  // ---------------- 기록 ----------------
  function saveRecord(rec) {
    var records = lsGet(LS.records, []);
    records.unshift({
      appId: rec.appId || state.currentApp || 'unknown',
      title: rec.title || null,
      score: rec.score != null ? rec.score : null,
      meta: rec.meta || null,
      at: rec.at || Date.now()
    });
    // 최근 200건만 유지
    if (records.length > 200) records.length = 200;
    lsSet(LS.records, records);
    if (state.activeTab === 'records') renderRecords();
  }

  // 서브앱이 자체 localStorage에 쌓는 일별 방문/문제 집계 읽기
  // 키 포맷: sm_visits_slowmath_<id> = [{date, sessions:[{total,correct,mode,t}], totalProblems, totalCorrect}, ...]
  function getAppVisits(appId) {
    try {
      var raw = localStorage.getItem('sm_visits_slowmath_' + appId);
      return JSON.parse(raw) || [];
    } catch (e) { return []; }
  }

  function getAppSummary(appId) {
    var visits = getAppVisits(appId);
    var problems = 0, correct = 0, lastAt = 0, sessions = 0;
    visits.forEach(function (v) {
      problems += (v.totalProblems || 0);
      correct += (v.totalCorrect || 0);
      (v.sessions || []).forEach(function (s) {
        sessions++;
        if (s.t && s.t > lastAt) lastAt = s.t;
      });
    });
    return {
      hasRecords: problems > 0,
      problems: problems,
      correct: correct,
      sessions: sessions,
      days: visits.length,
      lastAt: lastAt
    };
  }

  function fmtDate(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '.' +
      String(d.getMonth() + 1).padStart(2, '0') + '.' +
      String(d.getDate()).padStart(2, '0');
  }
  function fmtDateTime(ts) {
    var d = new Date(ts);
    return fmtDate(ts) + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0');
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---------------- 기록 탭 ----------------
  function renderRecords() {
    var mount = $('#sm-records-mount');
    if (!mount) return;
    if (state.recordsView === 'detail' && state.recordsApp) {
      renderRecordsDetail(mount, state.recordsApp);
    } else {
      renderRecordsPicker(mount);
    }
  }

  function renderRecordsPicker(mount) {
    var withRec = [];
    var noRec = [];
    window.SM_APPS.forEach(function (app) {
      var sum = getAppSummary(app.id);
      (sum.hasRecords ? withRec : noRec).push({ app: app, sum: sum });
    });
    // 기록 있는 연습: 최신 활동 순
    withRec.sort(function (a, b) { return b.sum.lastAt - a.sum.lastAt; });

    var html = '' +
      '<div class="records-header">' +
      '  <h2>기록</h2>' +
      '  <div class="sub">연습을 선택하면 기록을 볼 수 있어요</div>' +
      '</div>';

    html += '<div class="records-picker">';
    if (withRec.length) {
      html +=
        '<div class="rp-sec">' +
        '  <div class="rp-tit">기록이 있는 연습 <span class="rp-ct">' + withRec.length + '</span></div>' +
        '  <div class="rp-grid">' +
        withRec.map(function (x) {
          return (
            '<button type="button" class="rp-card" data-app="' + x.app.id + '">' +
              '<span class="rp-ic">' + x.app.icon + '</span>' +
              '<span class="rp-nm">' + escapeHtml(x.app.name) + '</span>' +
              '<span class="rp-meta">' + x.sum.problems + '문제 · ' + x.sum.days + '일</span>' +
            '</button>'
          );
        }).join('') +
        '  </div>' +
        '</div>';
    }
    if (noRec.length) {
      html +=
        '<div class="rp-sec">' +
        '  <div class="rp-tit rp-tit-dim">기록이 없는 연습 <span class="rp-ct">' + noRec.length + '</span></div>' +
        '  <div class="rp-grid">' +
        noRec.map(function (x) {
          return (
            '<button type="button" class="rp-card rp-card-dim" data-app="' + x.app.id + '">' +
              '<span class="rp-ic">' + x.app.icon + '</span>' +
              '<span class="rp-nm">' + escapeHtml(x.app.name) + '</span>' +
              '<span class="rp-meta rp-meta-dim">아직 기록 없음</span>' +
            '</button>'
          );
        }).join('') +
        '  </div>' +
        '</div>';
    }
    if (!withRec.length && !noRec.length) {
      html += '<div class="empty-state"><div class="emoji">📝</div><div class="msg">아직 기록이 없어요</div></div>';
    }
    html += '</div>';

    mount.innerHTML = html;
    // 카드 클릭 바인딩
    $$('.rp-card', mount).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-app');
        state.recordsView = 'detail';
        state.recordsApp = id;
        renderRecords();
      });
    });
  }

  function renderRecordsDetail(mount, appId) {
    var app = window.SM_FIND_APP(appId);
    if (!app) {
      state.recordsView = 'picker';
      state.recordsApp = null;
      renderRecordsPicker(mount);
      return;
    }

    // 기간 선택 pill
    var periodPills = RECORDS_PERIODS.map(function (p) {
      var active = (p.id === state.recordsPeriod) ? ' active' : '';
      return '<button type="button" class="sm-pp' + active + '" data-pid="' + p.id + '">' + p.label + '</button>';
    }).join('');

    var isMonth = state.recordsPeriod === 'month';

    var bodyHtml = isMonth
      // 월별 뷰 — 달력 + 트렌드 + 해당 월 방문일 전체 카드 리스트
      ? '<div class="sm-ms" id="sm-msum"></div>' +
        '<div class="sm-ch">' +
        '  <button type="button" class="sm-cn" onclick="window._smShellCN(-1)" aria-label="이전 달">‹</button>' +
        '  <div class="sm-cm" id="sm-clbl"></div>' +
        '  <button type="button" class="sm-cn" onclick="window._smShellCN(1)" aria-label="다음 달">›</button>' +
        '</div>' +
        '<table class="sm-cg"><thead><tr><th>일</th><th>월</th><th>화</th><th>수</th><th>목</th><th>금</th><th>토</th></tr></thead><tbody id="sm-cbody"></tbody></table>' +
        '<div id="sm-trend" class="sm-tg"></div>' +
        '<div id="sm-mo-list" class="sm-pd-list"></div>'
      // 기간 뷰 — 달력 없이 스탯 + 트렌드 + 일자 목록
      : '<div class="sm-ms" id="sm-msum"></div>' +
        '<div class="sm-pd-lbl" id="sm-pd-lbl"></div>' +
        '<div id="sm-trend" class="sm-tg"></div>' +
        '<div id="sm-pd-list" class="sm-pd-list"></div>';

    mount.innerHTML = '' +
      '<div class="records-detail-header">' +
      '  <button type="button" class="rd-back" id="sm-rd-back" aria-label="뒤로">' +
      '    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>' +
      '  </button>' +
      '  <span class="rd-ic">' + app.icon + '</span>' +
      '  <span class="rd-nm">' + escapeHtml(app.name) + '</span>' +
      '</div>' +
      '<div class="sm-pp-bar">' + periodPills + '</div>' +
      '<div class="records-detail-body">' + bodyHtml + '</div>';

    // 뒤로 버튼
    var back = $('#sm-rd-back', mount);
    if (back) back.addEventListener('click', function () {
      state.recordsView = 'picker';
      state.recordsApp = null;
      renderRecords();
    });

    // 기간 pill 클릭
    $$('.sm-pp', mount).forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.recordsPeriod = btn.getAttribute('data-pid');
        renderRecords();
      });
    });

    if (isMonth) renderCal();
    else renderPeriodView();
  }

  // 기간 뷰 렌더 (월별이 아닌 경우)
  function renderPeriodView() {
    var range = getPeriodRange(state.recordsPeriod);
    if (!range) return;
    var appId = state.recordsApp;
    var visits = getAppVisits(appId);

    // 해당 기간 내 visit 필터
    var filtered = visits.filter(function (v) {
      if (!v.date) return false;
      if (range.start && v.date < range.start) return false;
      if (range.end && v.date > range.end) return false;
      return (v.totalProblems || 0) > 0;
    }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });

    // 스탯 3카드
    var mT = 0, mC = 0, mD = filtered.length;
    filtered.forEach(function (v) {
      mT += v.totalProblems || 0;
      mC += v.totalCorrect || 0;
    });
    var su = document.getElementById('sm-msum');
    if (su) su.innerHTML = [
      '<div class="sm-mc"><div class="sm-mn">' + mD + '</div><div class="sm-ml">방문 일수</div></div>',
      '<div class="sm-mc"><div class="sm-mn">' + mT + '</div><div class="sm-ml">푼 문제 수</div></div>',
      '<div class="sm-mc"><div class="sm-mn">' + (mT > 0 ? Math.round(mC / mT * 100) : 0) + '%</div><div class="sm-ml">정답률</div></div>'
    ].join('');

    // 기간 레이블
    var lbl = document.getElementById('sm-pd-lbl');
    if (lbl) {
      lbl.textContent = (state.recordsPeriod === 'all')
        ? '전체 기간'
        : range.label;
    }

    // 트렌드 (막대만)
    var el = document.getElementById('sm-trend');
    if (el) {
      if (filtered.length === 0) {
        el.innerHTML = '<div class="sm-tg-title">학습 추이</div><div class="sm-tg-empty">이 기간에 기록이 없어요</div>';
      } else {
        el.innerHTML = '<div class="sm-tg-title">학습 추이</div><div class="sm-tg-chart">' + buildBarsSvg(filtered) + '</div>' + buildPeriodSummary(filtered);
      }
    }

    // 일자별 목록 (월별 day-detail과 동일한 .sm-dd 카드 포맷으로 통일)
    var list = document.getElementById('sm-pd-list');
    if (list) {
      if (filtered.length === 0) {
        list.innerHTML = '';
      } else {
        var items = filtered.slice().reverse().map(function (v) {
          var parts = (v.date || '').split('-');
          var dl = parts.length === 3
            ? (parseInt(parts[1], 10) + '월 ' + parseInt(parts[2], 10) + '일')
            : (v.date || '');
          var pct = v.totalProblems > 0
            ? Math.round((v.totalCorrect || 0) / v.totalProblems * 100)
            : 0;
          return '<div class="sm-dd">' +
            '<div class="sm-dt">📅 ' + dl + ' 기록</div>' +
            '<div class="sm-dr"><span class="sm-dl">총 푼 문제</span><span class="sm-dv">' + (v.totalProblems || 0) + '문제</span></div>' +
            '<div class="sm-dr"><span class="sm-dl">정답</span><span class="sm-dv">' + (v.totalCorrect || 0) + '개 <span class="sm-db">' + pct + '%</span></span></div>' +
            '</div>';
        }).join('');
        list.innerHTML = '<div class="sm-pd-lt">일자별 기록</div>' + items;
      }
    }
  }

  function buildBarsSvg(monthData) {
    var W = 320, H = 120, pad = 14, bot = 24, topM = 12;
    var maxP = 0;
    monthData.forEach(function (v) { if ((v.totalProblems || 0) > maxP) maxP = v.totalProblems; });
    if (maxP < 1) maxP = 1;
    var innerW = W - pad * 2;
    var n = monthData.length;
    var step = innerW / n;
    var barW = Math.max(2, Math.min(28, step * 0.62));
    var chartH = H - topM - bot;
    var midY = topM + chartH * 0.5;
    var refLine = '<line x1="' + pad + '" y1="' + midY.toFixed(1) + '" x2="' + (W - pad) + '" y2="' + midY.toFixed(1) + '" stroke="#E0DAD2" stroke-width="0.7" stroke-dasharray="2,3"/>';
    var bars = '', labels = '';
    monthData.forEach(function (v, i) {
      var cx = pad + step * (i + 0.5);
      var probH = ((v.totalProblems || 0) / maxP) * chartH;
      var by = topM + (chartH - probH);
      bars += '<rect x="' + (cx - barW / 2).toFixed(1) + '" y="' + by.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + probH.toFixed(1) + '" rx="2.5" fill="#6BADE8" opacity="0.85"/>';
      var showLbl = (n <= 10) || (i % Math.ceil(n / 10) === 0) || (i === n - 1);
      if (showLbl) {
        var day = parseInt((v.date || '').split('-')[2], 10) || 0;
        var month = parseInt((v.date || '').split('-')[1], 10) || 0;
        var lblText = (n > 31 || state.recordsPeriod === 'all') ? (month + '/' + day) : (day + '일');
        labels += '<text x="' + cx.toFixed(1) + '" y="' + (H - 8).toFixed(1) + '" text-anchor="middle" font-size="9" fill="#8C8070" font-weight="600">' + lblText + '</text>';
      }
    });
    var axisY = topM + chartH + 0.5;
    var axis = '<line x1="' + pad + '" y1="' + axisY + '" x2="' + (W - pad) + '" y2="' + axisY + '" stroke="#E0DAD2" stroke-width="1"/>';
    var maxLbl = '<text x="' + pad + '" y="' + (topM - 2) + '" font-size="8" fill="#B8AD9E" font-weight="600">최대 ' + maxP + '문제</text>';
    var midPVal = maxP / 2;
    var midPStr = (midPVal === Math.floor(midPVal)) ? String(midPVal) : midPVal.toFixed(1);
    var midLbl = '<text x="' + pad + '" y="' + (midY - 2).toFixed(1) + '" font-size="7" fill="#B8AD9E" font-weight="600">' + midPStr + '문제</text>';
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg">' + refLine + axis + maxLbl + midLbl + bars + labels + '</svg>';
  }

  function buildPeriodSummary(filtered) {
    var totalP = 0, totalC = 0;
    filtered.forEach(function (v) {
      totalP += v.totalProblems || 0;
      totalC += v.totalCorrect || 0;
    });
    var avgP = Math.round(totalP / filtered.length);
    var acc = totalP > 0 ? Math.round(totalC / totalP * 100) : 0;
    return '<div class="sm-tg-sum">일평균 <b>' + avgP + '</b>문제 · 정답률 <b>' + acc + '</b>%</div>';
  }

  // 월 달력 렌더링 (서브앱 _rCal 포팅)
  function renderCal() {
    var appId = state.recordsApp;
    if (!appId) return;
    var cy = state.recordsCalYear;
    var cm = state.recordsCalMonth;

    var lbl = document.getElementById('sm-clbl');
    if (lbl) lbl.textContent = cy + '년 ' + MONTH_NAMES[cm];

    var visits = getAppVisits(appId);
    var vm = {};
    visits.forEach(function (v) { vm[v.date] = v; });

    var first = new Date(cy, cm, 1).getDay();
    var days = new Date(cy, cm + 1, 0).getDate();
    var mT = 0, mC = 0, mD = 0;
    for (var d = 1; d <= days; d++) {
      var ds = cy + '-' + String(cm + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      if (vm[ds]) {
        mD++;
        mT += vm[ds].totalProblems || 0;
        mC += vm[ds].totalCorrect || 0;
      }
    }

    var su = document.getElementById('sm-msum');
    if (su) su.innerHTML = [
      '<div class="sm-mc"><div class="sm-mn">' + mD + '</div><div class="sm-ml">방문 일수</div></div>',
      '<div class="sm-mc"><div class="sm-mn">' + mT + '</div><div class="sm-ml">푼 문제 수</div></div>',
      '<div class="sm-mc"><div class="sm-mn">' + (mT > 0 ? Math.round(mC / mT * 100) : 0) + '%</div><div class="sm-ml">정답률</div></div>'
    ].join('');

    var body = document.getElementById('sm-cbody');
    if (body) {
      var html = '<tr>';
      for (var i = 0; i < first; i++) html += '<td><div class="sm-cd"></div></td>';
      for (var d2 = 1; d2 <= days; d2++) {
        var ds2 = cy + '-' + String(cm + 1).padStart(2, '0') + '-' + String(d2).padStart(2, '0');
        var cls = 'sm-cd';
        if (vm[ds2]) cls += ' smd';
        html += '<td><div class="' + cls + '" data-date="' + ds2 + '">' + d2 + '</div></td>';
        if ((first + d2 - 1) % 7 === 6 && d2 < days) html += '</tr><tr>';
      }
      body.innerHTML = html + '</tr>';
    }

    renderMonthList(vm, cy, cm, days);
    renderTrend();
  }

  // 해당 월의 방문일 전체를 .sm-dd 카드 리스트로 렌더 (최근 날짜부터)
  function renderMonthList(vm, cy, cm, days) {
    var host = document.getElementById('sm-mo-list');
    if (!host) return;
    var items = [];
    for (var d = days; d >= 1; d--) {
      var ds = cy + '-' + String(cm + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      var v = vm[ds];
      if (v && (v.totalProblems || 0) > 0) items.push(v);
    }
    if (items.length === 0) {
      host.innerHTML = '';
      return;
    }
    var itemsHtml = items.map(function (v) {
      var parts = (v.date || '').split('-');
      var dl = parts.length === 3
        ? (parseInt(parts[1], 10) + '월 ' + parseInt(parts[2], 10) + '일')
        : (v.date || '');
      var pct = v.totalProblems > 0
        ? Math.round((v.totalCorrect || 0) / v.totalProblems * 100)
        : 0;
      return '<div class="sm-dd">' +
        '<div class="sm-dt">📅 ' + dl + ' 기록</div>' +
        '<div class="sm-dr"><span class="sm-dl">총 푼 문제</span><span class="sm-dv">' + (v.totalProblems || 0) + '문제</span></div>' +
        '<div class="sm-dr"><span class="sm-dl">정답</span><span class="sm-dv">' + (v.totalCorrect || 0) + '개 <span class="sm-db">' + pct + '%</span></span></div>' +
        '</div>';
    }).join('');
    host.innerHTML = '<div class="sm-pd-lt">일자별 기록</div>' + itemsHtml;
  }

  // 이달의 학습 추이 SVG 렌더링 (서브앱 _rTrend 포팅)
  function renderTrend() {
    var el = document.getElementById('sm-trend');
    if (!el) return;
    var appId = state.recordsApp;
    if (!appId) return;
    var cy = state.recordsCalYear;
    var cm = state.recordsCalMonth;
    var visits = getAppVisits(appId);
    var monthData = visits.filter(function (v) {
      var p = (v.date || '').split('-');
      return p.length === 3
        && parseInt(p[0], 10) === cy
        && parseInt(p[1], 10) === cm + 1
        && (v.totalProblems || 0) > 0;
    }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });

    if (monthData.length === 0) {
      el.innerHTML = '<div class="sm-tg-title">이달의 학습 추이</div><div class="sm-tg-empty">이번 달 기록이 없어요</div>';
      return;
    }

    var W = 320, H = 120, pad = 14, bot = 24, top = 12;
    var maxP = 0, totalP = 0, totalC = 0;
    monthData.forEach(function (v) {
      if ((v.totalProblems || 0) > maxP) maxP = v.totalProblems;
      totalP += v.totalProblems || 0;
      totalC += v.totalCorrect || 0;
    });
    if (maxP < 1) maxP = 1;
    var innerW = W - pad * 2;
    var n = monthData.length;
    var step = innerW / n;
    var barW = Math.max(2, Math.min(28, step * 0.62));
    var chartH = H - top - bot;
    var midY = top + chartH * 0.5;
    var refLine = '<line x1="' + pad + '" y1="' + midY.toFixed(1) + '" x2="' + (W - pad) + '" y2="' + midY.toFixed(1) + '" stroke="#E0DAD2" stroke-width="0.7" stroke-dasharray="2,3"/>';
    var bars = '', labels = '';
    monthData.forEach(function (v, i) {
      var cx = pad + step * (i + 0.5);
      var probH = ((v.totalProblems || 0) / maxP) * chartH;
      var by = top + (chartH - probH);
      bars += '<rect x="' + (cx - barW / 2).toFixed(1) + '" y="' + by.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + probH.toFixed(1) + '" rx="2.5" fill="#6BADE8" opacity="0.85"/>';
      var day = parseInt((v.date || '').split('-')[2], 10) || 0;
      var showLbl = (n <= 10) || (i % Math.ceil(n / 10) === 0) || (i === n - 1);
      if (showLbl) {
        labels += '<text x="' + cx.toFixed(1) + '" y="' + (H - 8).toFixed(1) + '" text-anchor="middle" font-size="9" fill="#8C8070" font-weight="600">' + day + '일</text>';
      }
    });
    var axisY = top + chartH + 0.5;
    var axis = '<line x1="' + pad + '" y1="' + axisY + '" x2="' + (W - pad) + '" y2="' + axisY + '" stroke="#E0DAD2" stroke-width="1"/>';
    var maxLbl = '<text x="' + pad + '" y="' + (top - 2) + '" font-size="8" fill="#B8AD9E" font-weight="600">최대 ' + maxP + '문제</text>';
    var midPVal = maxP / 2;
    var midPStr = (midPVal === Math.floor(midPVal)) ? String(midPVal) : midPVal.toFixed(1);
    var midLbl = '<text x="' + pad + '" y="' + (midY - 2).toFixed(1) + '" font-size="7" fill="#B8AD9E" font-weight="600">' + midPStr + '문제</text>';
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="월별 문제 수 추이">' + refLine + axis + maxLbl + midLbl + bars + labels + '</svg>';
    var avgP = Math.round(totalP / monthData.length);
    var acc = totalP > 0 ? Math.round(totalC / totalP * 100) : 0;
    var summary = '<div class="sm-tg-sum">일평균 <b>' + avgP + '</b>문제 · 정답률 <b>' + acc + '</b>%</div>';
    el.innerHTML = '<div class="sm-tg-title">이달의 학습 추이</div><div class="sm-tg-chart">' + svg + '</div>' + summary;
  }

  // 월 이동 (inline onclick="window._smShellCN(±1)")
  window._smShellCN = function (delta) {
    state.recordsCalMonth += delta;
    if (state.recordsCalMonth < 0) { state.recordsCalMonth = 11; state.recordsCalYear--; }
    if (state.recordsCalMonth > 11) { state.recordsCalMonth = 0; state.recordsCalYear++; }
    renderCal();
  };

  // 일별 상세 단일 뷰는 월별 전체 리스트로 대체됨 — 이 함수는 과거 onclick 호환용 no-op로만 유지
  window._smShellDD = function () { /* no-op */ };

  // ---------------- 마이 (서브앱과 동일 포맷) ----------------
  var PROVIDER_KR = { kakao: '카카오', google: '구글', naver: '네이버', facebook: '페이스북' };

  // 로그인 방식 표시 — 공식 로고 칩
  function providerTagHTML(provider) {
    if (provider === 'kakao') {
      return '<span class="sm-provider-tag">' +
        '<span class="sm-provider-icon kakao">' +
          '<svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true">' +
            '<path d="M10 1C4.477 1 0 4.477 0 8.667c0 2.7 1.753 5.072 4.393 6.413-.192.717-.694 2.6-.794 3.004-.124.497.182.49.383.356.158-.105 2.51-1.708 3.525-2.398.8.118 1.628.18 2.493.18 5.523 0 10-3.477 10-7.555C20 4.477 15.523 1 10 1z" fill="#191919"/>' +
          '</svg>' +
        '</span>' +
        '<span>카카오</span>' +
        '</span>';
    }
    if (provider === 'google') {
      return '<span class="sm-provider-tag">' +
        '<span class="sm-provider-icon google">' +
          '<svg width="14" height="14" viewBox="0 0 48 48" aria-hidden="true">' +
            '<path d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" fill="#FFC107"/>' +
            '<path d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" fill="#FF3D00"/>' +
            '<path d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0124 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" fill="#4CAF50"/>' +
            '<path d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 01-4.087 5.571l.001-.001 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" fill="#1976D2"/>' +
          '</svg>' +
        '</span>' +
        '<span>Google</span>' +
        '</span>';
    }
    return PROVIDER_KR[provider] || provider;
  }

  function renderMy() {
    var user = lsGet(LS.user, null);
    var em = $('#sm-my-em');
    var pv = $('#sm-my-pv');
    if (em) em.textContent = (user && user.email) || 'sprit6487@gmail.com';
    if (pv) {
      var p = (user && user.provider) || 'kakao';
      pv.innerHTML = providerTagHTML(p);
    }
    renderCoupons();
    renderTickets();
  }

  // ── 더미 데이터 ── (실제 시스템 연결 시 교체)
  // 정책 (2026-04-28 기준)
  // - 이용권: { target(연습 id 또는 'ALL') + durationDays(1 또는 30) }
  //   · 회원가입 시 ALL × 1일 자동 부여
  //   · 인앱결제: N번 연습 × 30일
  //   · 쿠폰 교환: N번 연습 × 1일 (ALL은 교환 불가)
  // - 쿠폰: 공유/CS로 지급, N번 연습 × 1일 이용권으로 교환
  var COUPON_GRANT_LIMIT = 10; // 누적 부여 가능 최대 개수

  var DEMO_COUPONS = {
    // 시간순(최신 → 과거) history. event = 'grant' | 'use'
    history: [
      { event: 'grant', source: 'share',  at: '2026-04-28' },
      { event: 'use',   target: 'easy',    at: '2026-04-26' }, // 한 자리 덧셈 1일권 교환
      { event: 'grant', source: 'admin',   at: '2026-04-25', note: 'CS 지급' },
      { event: 'grant', source: 'share',   at: '2026-04-20' },
      { event: 'use',   target: 'plusone', at: '2026-04-12' }, // 더하기 1 1일권 교환
      { event: 'grant', source: 'share',   at: '2026-04-10' }
    ]
  };

  function appNameById(id) {
    if (id === 'ALL') return '모든 연습';
    var app = window.SM_FIND_APP && window.SM_FIND_APP(id);
    return app ? app.name : id;
  }

  // 이용권 더미 — 각 항목에 durationDays 명시 (1 또는 30)
  // 시연 토글: localStorage 'sm_demo_empty_tickets' === '1' 이면 current 비움
  // 콘솔에서 토글:
  //   localStorage.setItem('sm_demo_empty_tickets', '1'); location.reload();   // 빈 상태
  //   localStorage.removeItem('sm_demo_empty_tickets'); location.reload();      // 원래대로
  var _DEMO_TICKETS_BASE = {
    current: [
      { kind: 'paid', target: 'easy', durationDays: 30, from: '2026-04-15', to: '2026-05-14' }
    ],
    past: [
      { kind: 'free', target: 'easy',    durationDays: 1,  from: '2026-04-26', to: '2026-04-26', source: 'coupon' },
      { kind: 'paid', target: 'plusone', durationDays: 30, from: '2026-03-12', to: '2026-04-10' },
      { kind: 'free', target: 'ALL',     durationDays: 1,  from: '2026-04-10', to: '2026-04-10', source: 'signup' }
    ]
  };
  function getDemoTickets() {
    var emptyMode = false;
    try { emptyMode = localStorage.getItem('sm_demo_empty_tickets') === '1'; } catch (e) {}
    if (emptyMode) return { current: [], past: _DEMO_TICKETS_BASE.past };
    return _DEMO_TICKETS_BASE;
  }
  // legacy alias (다른 곳에서 참조 가능)
  var DEMO_TICKETS = _DEMO_TICKETS_BASE;

  function fmtDate(s) { return (s || '').replace(/-/g, '.'); }
  function fmtKDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return s;
    return m[1] + '년 ' + parseInt(m[2], 10) + '월 ' + parseInt(m[3], 10) + '일';
  }
  // 이용권 표시 이름: "한 자리 덧셈 30일 이용권" / "모든 연습 1일 이용권"
  function ticketLabel(t) {
    return appNameById(t.target) + ' ' + t.durationDays + '일 이용권';
  }

  function renderCoupons() {
    var card = $('#sm-my-coupon-card');
    if (!card) return;
    card.classList.add('sm-my-coupon-card');
    var data = DEMO_COUPONS;
    var grants = data.history.filter(function (h) { return h.event === 'grant'; });
    var uses = data.history.filter(function (h) { return h.event === 'use'; });
    var totalGranted = grants.length;
    var available = totalGranted - uses.length;

    var html = '';
    // 보유 강조 박스
    html += '<div class="sm-my-coupon-balance">';
    html += '<div class="lbl">';
    html += '<span class="title">🎟️ 내 쿠폰</span>';
    html += '<span class="sub">공유하고 받은 쿠폰이에요</span>';
    html += '</div>';
    html += '<div class="count"><span class="num">' + available + '</span><span class="unit">장</span></div>';
    html += '</div>';

    // 누적 10개 미만이면 공유 CTA — 클릭 시 실제 공유 함수 실행
    if (totalGranted < COUPON_GRANT_LIMIT) {
      var remain = COUPON_GRANT_LIMIT - totalGranted;
      var pct = Math.round((totalGranted / COUPON_GRANT_LIMIT) * 100);
      html += '<button class="sm-my-share-cta" id="sm-my-share-cta" type="button">';
      html += '<div class="head"><span class="title">🎁 친구에게 알려주기</span><span class="arrow">›</span></div>';
      html += '<div class="meta">공유하면 쿠폰 1장을 받을 수 있어요. (' + totalGranted + '/' + COUPON_GRANT_LIMIT + ')</div>';
      html += '<div class="progress"><div style="width:' + pct + '%"></div></div>';
      html += '</button>';
    }

    // 이용 내역 진입 링크 (한 뎁스 들어가야 보임)
    if (data.history.length > 0) {
      html += '<button class="sm-my-link sm-my-link-history" type="button" id="sm-my-coupon-history-link">' +
        '<span class="sm-my-link-lbl">쿠폰 사용 기록 <span class="sm-my-history-count">' + data.history.length + '</span></span>' +
        '<span class="sm-my-link-arrow">›</span>' +
        '</button>';
    }

    card.innerHTML = html;

    var couponLink = document.getElementById('sm-my-coupon-history-link');
    if (couponLink) couponLink.addEventListener('click', openCouponHistory);
    var shareCta = document.getElementById('sm-my-share-cta');
    if (shareCta) shareCta.addEventListener('click', shellShare);
  }

  function ticketRowHTML(t, isPast) {
    return '<div class="sm-my-ticket-row' + (isPast ? ' expired' : '') + '">' +
      '<div class="sm-my-ticket-line1">' +
      '<span class="sm-my-ticket-name">' + ticketLabel(t) + '</span>' +
      '</div>' +
      '<div class="sm-my-ticket-period">' + fmtDate(t.from) + ' ~ ' + fmtDate(t.to) + '</div>' +
      '</div>';
  }

  // 출처별 SVG 아이콘 — 모든 SVG에 동일한 invisible bbox rect (3,5,18,14)를 두어
  // 브라우저가 인식하는 vertical bounding을 강제 통일 → 시각 하단 라인 일치
  var _BBOX_RECT = '<rect x="3" y="5" width="18" height="14" fill="none" stroke="none"/>';
  var SVG_ICON = {
    card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      _BBOX_RECT +
      '<rect x="3" y="5" width="18" height="14" rx="2"/>' +
      '<line x1="3" y1="10" x2="21" y2="10"/>' +
      '<line x1="6" y1="15" x2="10" y2="15"/>' +
      '</svg>',
    ticket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      _BBOX_RECT +
      '<path d="M3 9 V7 a2 2 0 0 1 2 -2 h14 a2 2 0 0 1 2 2 v2 a2 2 0 0 0 0 6 v2 a2 2 0 0 1 -2 2 h-14 a2 2 0 0 1 -2 -2 v-2 a2 2 0 0 0 0 -6 z"/>' +
      '<line x1="9" y1="11" x2="9" y2="13"/>' +
      '<line x1="15" y1="11" x2="15" y2="13"/>' +
      '</svg>',
    gift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      _BBOX_RECT +
      '<polyline points="21 11 21 19 3 19 3 11"/>' +
      '<rect x="3" y="9" width="18" height="2"/>' +
      '<line x1="12" y1="19" x2="12" y2="9"/>' +
      '<path d="M12 9 H8 a1.7 1.7 0 0 1 0 -4 C11 5 12 9 12 9 Z"/>' +
      '<path d="M12 9 h4 a1.7 1.7 0 0 0 0 -4 C13 5 12 9 12 9 Z"/>' +
      '</svg>'
  };

  // 마이 탭용 작은 거북이 SVG (빈 상태 등에 사용)
  var SM_MINI_TURTLE_SVG =
    '<svg class="turtle" viewBox="0 0 80 60" width="72" height="54" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<ellipse cx="20" cy="44" rx="7" ry="4" fill="#F2DC8C" stroke="#3A9B6A" stroke-width="1.6" transform="rotate(-15 20 44)"/>' +
    '<ellipse cx="56" cy="46" rx="7" ry="4" fill="#F2DC8C" stroke="#3A9B6A" stroke-width="1.6" transform="rotate(12 56 46)"/>' +
    '<ellipse cx="38" cy="38" rx="22" ry="13" fill="#F5E6C8" stroke="#3A9B6A" stroke-width="1.8"/>' +
    '<ellipse cx="36" cy="28" rx="20" ry="17" fill="#7EDCAA" stroke="#3A9B6A" stroke-width="2"/>' +
    '<ellipse cx="62" cy="26" rx="11" ry="9" fill="#F5E6C8" stroke="#3A9B6A" stroke-width="2"/>' +
    '<circle cx="67" cy="22" r="2.4" fill="white" stroke="#3A9B6A" stroke-width="1"/>' +
    '<circle cx="67.8" cy="21.6" r="1.4" fill="#3A9B6A"/>' +
    '<path d="M62 30 Q66 33 70 30" fill="none" stroke="#3A9B6A" stroke-width="1.2" stroke-linecap="round"/>' +
    '</svg>';

  function renderTickets() {
    var card = $('#sm-my-ticket-card');
    if (!card) return;
    card.classList.add('sm-my-ticket-card');
    var data = getDemoTickets();

    var html = '';
    if (data.current.length > 0) {
      // 파란 강조 박스 자체가 "사용 중" 의미를 전달 — 별도 라벨 없음
      data.current.forEach(function (t) { html += ticketRowHTML(t, false); });
    } else {
      // 빈 상태 — 미니멀 티켓 outline + 차분한 메시지
      html += '<div class="sm-my-ticket-empty">';
      html += '<div class="ic">' + SVG_ICON.ticket + '</div>';
      html += '<div class="title">아직 이용권이 없어요</div>';
      html += '</div>';
    }
    // 만료된 이용권 진입 링크
    if (data.past.length > 0) {
      html += '<button class="sm-my-link sm-my-link-history" type="button" id="sm-my-history-link" style="margin-top:6px;">' +
        '<span class="sm-my-link-lbl">만료된 이용권 <span class="sm-my-history-count">' + data.past.length + '</span></span>' +
        '<span class="sm-my-link-arrow">›</span>' +
        '</button>';
    }
    card.innerHTML = html;

    var link = document.getElementById('sm-my-history-link');
    if (link) link.addEventListener('click', openTicketHistory);
  }

  function toggleDemoEmptyTickets() {
    var current = false;
    try { current = localStorage.getItem('sm_demo_empty_tickets') === '1'; } catch (e) {}
    try {
      if (current) localStorage.removeItem('sm_demo_empty_tickets');
      else localStorage.setItem('sm_demo_empty_tickets', '1');
    } catch (e) {}
    renderTickets();
  }

  function openHistoryOverlay(title, bodyHtml) {
    var overlay = document.getElementById('sm-history-overlay');
    var body = document.getElementById('sm-history-body');
    var titleEl = document.getElementById('sm-history-title');
    if (!overlay || !body || !titleEl) return;
    titleEl.innerHTML = title; // HTML 허용 (카운트 배지 등)
    body.innerHTML = bodyHtml;
    overlay.hidden = false;
    body.scrollTop = 0;
  }
  function closeHistoryOverlay() {
    var overlay = document.getElementById('sm-history-overlay');
    if (overlay) overlay.hidden = true;
  }
  function ticketHistoryRowHTML(t) {
    var sourceCls, sourceLabel, sourceIcon;
    if (t.kind === 'paid') {
      sourceCls = 'paid'; sourceLabel = '결제'; sourceIcon = SVG_ICON.card;
    } else if (t.source === 'coupon') {
      sourceCls = 'coupon'; sourceLabel = '쿠폰 교환'; sourceIcon = SVG_ICON.ticket;
    } else if (t.source === 'signup') {
      sourceCls = 'signup'; sourceLabel = '가입 선물'; sourceIcon = SVG_ICON.gift;
    } else {
      sourceCls = 'paid'; sourceLabel = ''; sourceIcon = '';
    }
    var period = (t.from === t.to)
      ? fmtDate(t.from) + ' (하루 이용)'
      : fmtDate(t.from) + ' ~ ' + fmtDate(t.to);
    return '<div class="sm-ticket-history-row ' + sourceCls + '">' +
      '<div class="name">' + ticketLabel(t) + '</div>' +
      '<div class="source">' + sourceIcon + '<span>' + sourceLabel + '</span></div>' +
      '<div class="period">' + period + '</div>' +
      '</div>';
  }

  function openTicketHistory() {
    var data = getDemoTickets();
    var html = '';
    if (!data.past.length) {
      html = '<div class="sm-my-empty">' + SM_MINI_TURTLE_SVG +
        '<div class="title" style="margin-top:8px;font-weight:800;color:#4A4035;">만료된 이용권이 없어요</div></div>';
    } else {
      // P2 — 상단 요약 (출처별 카운트)
      var paidCount = 0, couponCount = 0, signupCount = 0;
      data.past.forEach(function (t) {
        if (t.kind === 'paid') paidCount++;
        else if (t.source === 'coupon') couponCount++;
        else if (t.source === 'signup') signupCount++;
      });
      var chips = [];
      if (paidCount)   chips.push('<div class="summary-chip ticket-paid"><span class="ic">' + SVG_ICON.card + '</span><span class="num">' + paidCount + '</span><span class="lbl">결제</span></div>');
      if (couponCount) chips.push('<div class="summary-chip ticket-coupon"><span class="ic">' + SVG_ICON.ticket + '</span><span class="num">' + couponCount + '</span><span class="lbl">쿠폰</span></div>');
      if (signupCount) chips.push('<div class="summary-chip ticket-signup"><span class="ic">' + SVG_ICON.gift + '</span><span class="num">' + signupCount + '</span><span class="lbl">가입</span></div>');
      if (chips.length > 0) {
        var gridCls = chips.length === 3 ? 'three' : '';
        html += '<div class="sm-history-summary ' + gridCls + '">' + chips.join('') + '</div>';
      }
      // P1 — 출처별 색조 row
      data.past.forEach(function (t) { html += ticketHistoryRowHTML(t); });
    }
    // P3 — 헤더 카운트
    var title = '만료된 이용권' +
      (data.past.length ? '<span class="sm-history-title-count">' + data.past.length + '</span>' : '');
    openHistoryOverlay(title, html);
  }
  function timelineItemHTML(h) {
    var qty, qtyCls, lbl, eventCls;
    if (h.event === 'grant') {
      qty = '+1'; qtyCls = 'plus'; eventCls = 'grant';
      lbl = h.source === 'admin' ? '관리자 지급' : '공유 보상';
    } else {
      qty = '−1'; qtyCls = 'minus'; eventCls = 'use';
      lbl = appNameById(h.target) + ' 1일 이용권 교환';
    }
    return '<div class="sm-timeline-item ' + eventCls + '">' +
      '<div class="dot"></div>' +
      '<div class="row-card">' +
        '<div class="head">' +
          '<span class="qty ' + qtyCls + '">' + qty + '</span>' +
          '<span class="lbl">' + lbl + '</span>' +
        '</div>' +
        '<div class="date">' + fmtKDate(h.at) + '</div>' +
      '</div>' +
      '</div>';
  }

  function openCouponHistory() {
    var data = DEMO_COUPONS;
    var grants = data.history.filter(function (h) { return h.event === 'grant'; });
    var uses   = data.history.filter(function (h) { return h.event === 'use'; });

    var html = '';
    if (!data.history.length) {
      html = '<div class="sm-my-empty">' + SM_MINI_TURTLE_SVG +
        '<div class="title" style="margin-top:8px;font-weight:800;color:#4A4035;">쿠폰 사용 기록이 없어요</div></div>';
    } else {
      // P1 — 상단 요약
      html += '<div class="sm-history-summary">' +
        '<div class="summary-chip plus"><span class="ic">' + SVG_ICON.gift + '</span><span class="num">+' + grants.length + '</span><span class="lbl">받은 쿠폰</span></div>' +
        '<div class="summary-chip minus"><span class="ic">' + SVG_ICON.ticket + '</span><span class="num">−' + uses.length + '</span><span class="lbl">사용한 쿠폰</span></div>' +
        '</div>';
      // P2 — 타임라인
      html += '<div class="sm-timeline">';
      data.history.forEach(function (h) { html += timelineItemHTML(h); });
      html += '</div>';
    }
    // P3 — 헤더 카운트
    var title = '쿠폰 사용 기록' +
      (data.history.length ? '<span class="sm-history-title-count">' + data.history.length + '</span>' : '');
    openHistoryOverlay(title, html);
  }

  function doLogout() {
    // 쉘 유저 + 모든 서브앱 로그인 키 제거
    try { localStorage.removeItem(LS.user); } catch (e) { /* noop */ }
    clearAllSubappLogins();
    renderMy();

    // iframe 제거 + 홈 탭 상태 초기화 (다음 연습 선택 시 fresh 로드)
    if (state.iframeEl && state.iframeEl.parentNode) {
      state.iframeEl.parentNode.removeChild(state.iframeEl);
    }
    state.iframeEl = null;
    state.currentApp = null;
    state.pendingPlayRequest = null;
    document.body.classList.remove('game-active');

    // 홈 탭 빈 상태 노출 준비
    var wrap = $('#home-iframe-wrap');
    var empty = $('#home-empty');
    if (wrap) { wrap.style.display = 'none'; wrap.innerHTML = ''; }
    if (empty) empty.style.display = '';

    // 로그아웃 후에는 항상 시리즈 탭으로 이동
    // 거기서 연습을 고르면 → 홈 탭 → 시작하기 → 로그인 뷰 → 로그인 → 플레이
    setTab('series');
    renderSeries(); // '현재' 배지 제거 갱신
  }

  // ---------------- 공유 (서브앱 shareApp과 동일 로직) ----------------
  // 공유 UI 가시성 — 시리즈 탭에 고정 노출 (로그인 상태에서만).
  // 조건을 모두 AND로 계산하고 매 상태 전환마다 호출한다.
  function updateShareVisibility() {
    var btn = $('#sm-share-btn');
    var bubble = $('#sm-share-bubble');
    if (!btn && !bubble) return;
    var body = document.body;
    var okShare = isLoggedIn();
    var days = parseInt(lsGet(LS.shareDays, 0), 10) || 0;

    var shouldShow =
         !body.classList.contains('splash-active')
      && body.classList.contains('tab-series')
      && okShare;

    var showBubble = shouldShow && days < SHARE_MAX;

    if (btn) btn.style.display = shouldShow ? 'flex' : 'none';
    if (bubble) bubble.style.display = showBubble ? 'block' : 'none';
  }

  function showToast(msg) {
    var t = $('#sm-share-toast');
    if (!t) return;
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._smTimer);
    t._smTimer = setTimeout(function () { t.style.opacity = '0'; }, 3000);
  }

  // 공유할 slowmath_all 페이지의 캐노니컬 URL.
  // origin + pathname만 사용 — 현재 탭의 쿼리·해시·임시 파라미터 제외.
  // 푸시 후 GitHub Pages·Vercel·커스텀 도메인 어디로 배포돼도 자동으로 그 URL이 됨.
  function getCanonicalShareUrl() {
    var path = location.pathname || '/';
    // 파일명 붙은 경우(/index.html) 디렉토리 루트로 정리
    path = path.replace(/\/index\.html?$/i, '/');
    return location.origin + path;
  }

  function shellShare() {
    function onShared() {
      var days = parseInt(lsGet(LS.shareDays, 0), 10) || 0;
      if (days < SHARE_MAX) {
        days = days + 1;
        lsSet(LS.shareDays, days);
      }
      updateShareVisibility();
      showToast('하루 무료 이용권이 지급되었습니다!');
    }
    var title = document.title;
    var url = getCanonicalShareUrl();
    if (navigator.share) {
      navigator.share({ title: title, url: url }).then(onShared).catch(function () { /* 취소: 무시 */ });
    } else {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).catch(function () { /* noop */ });
      }
      alert('링크가 복사되었어요!');
      onShared();
    }
  }

  function showWithdrawModal() {
    var mask = $('#sm-modal-withdraw');
    if (mask) mask.classList.add('show');
  }
  function hideWithdrawModal() {
    var mask = $('#sm-modal-withdraw');
    if (mask) mask.classList.remove('show');
  }
  function doWithdraw() {
    // 회원 탈퇴 — user/tickets/records 모두 삭제 + 로그아웃 정리
    try { localStorage.removeItem(LS.user); } catch (e) {}
    try { localStorage.removeItem(LS.tickets); } catch (e) {}
    try { localStorage.removeItem(LS.records); } catch (e) {}
    clearAllSubappLogins();
    hideWithdrawModal();
    renderMy();
    renderRecords();

    if (state.iframeEl && state.iframeEl.parentNode) {
      state.iframeEl.parentNode.removeChild(state.iframeEl);
    }
    state.iframeEl = null;
    state.currentApp = null;
    state.pendingPlayRequest = null;
    document.body.classList.remove('game-active');

    var wrap = $('#home-iframe-wrap');
    var empty = $('#home-empty');
    if (wrap) { wrap.style.display = 'none'; wrap.innerHTML = ''; }
    if (empty) empty.style.display = '';

    setTab('series');
    renderSeries();
    showToast('회원 탈퇴가 완료되었어요');
  }

  function wireShareAndMy() {
    var shareBtn = $('#sm-share-btn');
    if (shareBtn) shareBtn.addEventListener('click', shellShare);
    var logoutBtn = $('#sm-my-logout');
    if (logoutBtn) logoutBtn.addEventListener('click', doLogout);
    // 시연용: 이용권 있음/없음 토글
    var ticketsToggle = $('#sm-my-tickets-toggle');
    if (ticketsToggle) ticketsToggle.addEventListener('click', toggleDemoEmptyTickets);
    // 회원 탈퇴
    var withdrawLink = $('#sm-my-withdraw');
    if (withdrawLink) withdrawLink.addEventListener('click', showWithdrawModal);
    var withdrawCancel = $('#sm-withdraw-cancel');
    if (withdrawCancel) withdrawCancel.addEventListener('click', hideWithdrawModal);
    var withdrawOk = $('#sm-withdraw-ok');
    if (withdrawOk) withdrawOk.addEventListener('click', doWithdraw);
    // 로그인 뷰 버튼
    var kakaoBtn = $('#sm-login-kakao');
    if (kakaoBtn) kakaoBtn.addEventListener('click', function () { doShellLogin('kakao'); });
    var googleBtn = $('#sm-login-google');
    if (googleBtn) googleBtn.addEventListener('click', function () { doShellLogin('google'); });
    updateShareVisibility();
  }

  // ---------------- 부팅 ----------------
  function boot() {
    wireTabs();
    wireHomeEmpty();
    wireModals();
    wireShareAndMy();
    renderSeries();
    renderRecords();
    renderMy();

    // 탭 전환 시 해당 탭 내용 갱신
    $$('.sm-tabbar .tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var t = btn.getAttribute('data-tab');

        // 로그아웃 상태에서 기록/마이 탭 접근 시 풀스크린 로그인 뷰 오버레이
        // (탭 전환은 허용하되 뷰가 위에 덮음 — 로그인하면 바로 해당 탭 사용 가능)
        if ((t === 'records' || t === 'my') && !isLoggedIn()) {
          showLoginView();
        } else if (t !== 'records' && t !== 'my') {
          hideLoginView();
        }

        if (t === 'records') {
          // 기록 탭 진입 시 항상 picker로 리셋 ("진입하면 연습을 선택하도록")
          state.recordsView = 'picker';
          state.recordsApp = null;
          var n = new Date();
          state.recordsCalYear = n.getFullYear();
          state.recordsCalMonth = n.getMonth();
          renderRecords();
        } else if (t === 'my') {
          renderMy();
        } else if (t === 'series') {
          // 현재 iframe에 로드된 앱 반영해 '현재' 배지 갱신
          renderSeries();
        }
      });
    });

    window.addEventListener('message', handleIframeMessage);

    // 최종 보루: 500ms마다 로그인 뷰 가시성 강제 재평가 (다른 감지 경로가 모두 실패해도 catch)
    setInterval(function () {
      if (state.activeTab === 'home' && state.iframeEl && !isLoggedIn()) {
        updateLoginViewVisibility();
      }
    }, 500);

    // 서브앱 로그인 상태를 쉘 user와 양방향 동기화 (storage 이벤트)
    setupSubappLoginSync();

    // 첫 랜딩 = 시리즈
    setTab('series');

    // 스플래시 타임아웃
    setTimeout(hideSplash, SPLASH_MS);

    // 개발자 편의: URL 파라미터로 플래그 강제 켜기 (?flags=auth,ticket)
    try {
      var qs = new URLSearchParams(location.search);
      var f = qs.get('flags');
      if (f) {
        f.split(',').forEach(function (n) {
          n = n.trim();
          if (n === 'auth') FLAGS.auth = true;
          if (n === 'ticket') FLAGS.ticket = true;
        });
      }
    } catch (e) { /* noop */ }

    // 외부(iframe) 디버그용 노출
    window.SM_SHELL = {
      flags: FLAGS,
      selectApp: selectApp,
      setTab: setTab,
      sendToIframe: sendToIframe
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
