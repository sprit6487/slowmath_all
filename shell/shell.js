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
    auth: false,     // true가 되면 로그인 게이트 활성화
    ticket: false    // true가 되면 이용권/결제 게이트 활성화
  };

  var LS = {
    records:    'sm.shell.records',
    user:       'sm.shell.user',
    tickets:    'sm.shell.tickets',
    shareDays:  'sm.shell.share_days'
  };

  var SHARE_MAX = 5;

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
      var grid = document.createElement('div');
      grid.className = 'sm-sg';
      group.apps.forEach(function (app) {
        var cur = app.id === state.currentApp;
        var card = document.createElement('button');
        card.type = 'button';
        card.className = 'sm-si' + (cur ? ' smc' : '');
        card.setAttribute('data-app', app.id);
        card.innerHTML =
          '<span class="sm-se">' + app.icon + '</span>' +
          '<span class="sm-sn">' + app.name + '</span>' +
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
    // 1) 인증 게이트
    if (FLAGS.auth) {
      var user = lsGet(LS.user, null);
      if (!user) { showLoginModal(); return; }
    }
    // 2) 이용권 게이트
    if (FLAGS.ticket) {
      var tickets = lsGet(LS.tickets, null);
      if (!tickets || !tickets.active) { showPaymentModal(); return; }
    }
    // 3) 통과 → 게임 시작 허용
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
  function showLoginModal() {
    var mask = $('#sm-modal-login');
    if (mask) mask.classList.add('show');
  }
  function hideLoginModal() {
    var mask = $('#sm-modal-login');
    if (mask) mask.classList.remove('show');
  }
  function showPaymentModal() {
    var mask = $('#sm-modal-payment');
    if (mask) mask.classList.add('show');
  }
  function hidePaymentModal() {
    var mask = $('#sm-modal-payment');
    if (mask) mask.classList.remove('show');
  }

  function wireModals() {
    // 로그인 모달 — MVP: "로그인(가짜)" 버튼으로 더미 유저 세팅
    var loginOk = $('#sm-login-ok');
    if (loginOk) loginOk.addEventListener('click', function () {
      var info = {
        id: 'demo',
        name: '데모 사용자',
        email: 'sprit6487@gmail.com',
        provider: 'kakao',
        at: Date.now()
      };
      lsSet(LS.user, info);
      propagateSubappLogin(info);  // 서브앱 게이트도 함께 통과되도록
      hideLoginModal();
      renderMy();
      if (state.pendingPlayRequest) runPlayGate();
    });
    var loginCancel = $('#sm-login-cancel');
    if (loginCancel) loginCancel.addEventListener('click', function () {
      hideLoginModal();
      state.pendingPlayRequest = null;
    });

    // 결제 모달 — MVP: "구매(가짜)" 버튼으로 이용권 활성화
    var payOk = $('#sm-pay-ok');
    if (payOk) payOk.addEventListener('click', function () {
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

  function renderMy() {
    var user = lsGet(LS.user, null);
    var em = $('#sm-my-em');
    var pv = $('#sm-my-pv');
    if (em) em.textContent = (user && user.email) || 'sprit6487@gmail.com';
    if (pv) {
      var p = (user && user.provider) || 'kakao';
      pv.textContent = PROVIDER_KR[p] || p;
    }
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

  function wireShareAndMy() {
    var shareBtn = $('#sm-share-btn');
    if (shareBtn) shareBtn.addEventListener('click', shellShare);
    var logoutBtn = $('#sm-my-logout');
    if (logoutBtn) logoutBtn.addEventListener('click', doLogout);
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
