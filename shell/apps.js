/**
 * 슬로매스 통합 쉘 — 서브앱 카탈로그
 * id = 폴더명(`slowmath_{id}`)과 1:1 매핑되는 안정 식별자.
 */
(function (global) {
  var APPS = [
    { id: 'color',      name: '색깔 익히기',      icon: '🌈',  category: '기초 인지' },
    { id: 'linedraw',   name: '선 긋기',          icon: '✏️',  category: '기초 인지' },
    { id: 'dot2dot',    name: '점선 따라 그리기', icon: '···', category: '기초 인지' },
    { id: 'colorcopy',  name: '똑같이 맞추기',    icon: '🪞',  category: '기초 인지' },
    { id: 'pattern',    name: '패턴 연습',        icon: '🧩',  category: '기초 인지' },

    { id: 'number',     name: '숫자 익히기',      icon: '🔢',  category: '수 개념' },
    { id: 'numberdraw', name: '숫자 쓰기',        icon: '5️⃣',  category: '수 개념' },
    { id: 'dice',       name: '세기',             icon: '🎲',  category: '수 개념' },
    { id: 'counting',   name: '우리말 세기',      icon: '🗣️',  category: '수 개념' },
    { id: 'matching',   name: '숫자 매칭',        icon: '🎯',  category: '수 개념' },

    { id: 'comparing',  name: '비교하기 기초',    icon: '⚖️',  category: '수 관계' },
    { id: 'comparing2', name: '비교하기 기초 2',  icon: '⚖️',  category: '수 관계' },
    { id: 'clock',      name: '시계 보기',        icon: '🕐',  category: '수 관계' },

    { id: 'combining',  name: '모으기 연습',      icon: '🫱',  category: '덧셈 전 개념' },
    { id: 'splitting',  name: '가르기 연습',      icon: '✂️',  category: '덧셈 전 개념' },
    { id: 'complement', name: '보수 연습',        icon: '🔟',  category: '덧셈 전 개념' },

    { id: 'plusone',    name: '더하기 1',         icon: '1️⃣',  category: '덧셈' },
    { id: 'plustwo',    name: '더하기 2',         icon: '2️⃣',  category: '덧셈' },
    { id: 'plusthree',  name: '더하기 3',         icon: '3️⃣',  category: '덧셈' },
    { id: 'easy',       name: '한 자리 덧셈',     icon: '➕',  category: '덧셈' },
    { id: 'circle',     name: '한 자리 덧셈 연습',icon: '➕',  category: '덧셈' },
    { id: 'verticaladd',name: '세로 덧셈',        icon: '🧮',  category: '덧셈' },

    { id: 'minusone',   name: '빼기 1',           icon: '1️⃣',  category: '뺄셈' },
    { id: 'minustwo',   name: '빼기 2',           icon: '2️⃣',  category: '뺄셈' },
    { id: 'minusthree', name: '빼기 3',           icon: '3️⃣',  category: '뺄셈' },
    { id: 'verticalsub',name: '세로 뺄셈',        icon: '🧮',  category: '뺄셈' },

    { id: 'timestables',name: '구구단 연습',      icon: '✖️',  category: '곱셈' },

    { id: 'payment_demo', name: '결제 플로우',     icon: '💳',  category: '데모' }
  ];

  var CATEGORY_ORDER = ['기초 인지', '수 개념', '수 관계', '덧셈 전 개념', '덧셈', '뺄셈', '곱셈', '데모'];

  // 카테고리별 부제 — slowkids.net(everydaysummer)과 동일
  var CATEGORY_DESCRIPTIONS = {
    '기초 인지':   '눈과 손이 먼저 익숙해지는 시간',
    '수 개념':     '숫자가 ‘양’으로 보이기 시작할 때',
    '수 관계':     '크고 작고, 같고 다름을 읽는 연습',
    '덧셈 전 개념': '모으고 가르며 수를 만져보는 경험',
    '덧셈':        '작은 걸음부터 쌓아올리는 계산',
    '뺄셈':        '한 걸음씩 덜어내는 계산',
    '곱셈':        '개념을 이해하는 수의 규칙',
    '데모':        '시연·검토용 플로우 (학습 콘텐츠 아님)'
  };

  // 서브앱 index.html은 쉘의 ?v=N과 별개로 캐시되므로 iframe URL에도 버전 파라미터를 붙임
  var SUBAPP_VERSION = '96';
  function path(id) {
    return './slowmath_' + id + '/?embedded=1&sv=' + SUBAPP_VERSION;
  }

  function find(id) {
    for (var i = 0; i < APPS.length; i++) {
      if (APPS[i].id === id) return APPS[i];
    }
    return null;
  }

  function grouped() {
    var map = {};
    CATEGORY_ORDER.forEach(function (c) { map[c] = []; });
    APPS.forEach(function (a) {
      if (!map[a.category]) map[a.category] = [];
      map[a.category].push(a);
    });
    return CATEGORY_ORDER.map(function (c) {
      return { category: c, description: CATEGORY_DESCRIPTIONS[c] || '', apps: map[c] };
    });
  }

  global.SM_APPS = APPS;
  global.SM_APPS_GROUPED = grouped;
  global.SM_APP_PATH = path;
  global.SM_FIND_APP = find;
  global.SM_CATEGORY_DESCRIPTIONS = CATEGORY_DESCRIPTIONS;
})(window);
