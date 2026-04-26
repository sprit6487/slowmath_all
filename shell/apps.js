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
    { id: 'matching',   name: '숫자 매칭',        icon: '🎯',  category: '수 개념' },

    { id: 'comparing',  name: '비교하기 기초',    icon: '⚖️',  category: '수 관계' },
    { id: 'comparing2', name: '비교하기 기초 2',  icon: '⚖️',  category: '수 관계' },
    { id: 'clock',      name: '시계 보기',        icon: '🕐',  category: '수 관계' },
    { id: 'counting',   name: '우리말 세기',      icon: '🧮',  category: '수 관계' },

    { id: 'combining',  name: '모으기 연습',      icon: '🫱',  category: '덧셈 전 개념' },
    { id: 'splitting',  name: '가르기 연습',      icon: '✂️',  category: '덧셈 전 개념' },
    { id: 'complement', name: '보수 연습',        icon: '🔟',  category: '덧셈 전 개념' },

    { id: 'plusone',    name: '더하기 1',         icon: '1️⃣',  category: '연산' },
    { id: 'plustwo',    name: '더하기 2',         icon: '2️⃣',  category: '연산' },
    { id: 'plusthree',  name: '더하기 3',         icon: '3️⃣',  category: '연산' },
    { id: 'easy',       name: '한 자리 덧셈',     icon: '➕',  category: '연산' },
    { id: 'circle',     name: '한 자리 덧셈 연습',icon: '➕',  category: '연산' },
    { id: 'minusone',   name: '빼기 1',           icon: '1️⃣',  category: '연산' },
    { id: 'minustwo',   name: '빼기 2',           icon: '2️⃣',  category: '연산' },
    { id: 'minusthree', name: '빼기 3',           icon: '3️⃣',  category: '연산' },
    { id: 'timestables',name: '구구단 연습',      icon: '✖️',  category: '연산' }
  ];

  var CATEGORY_ORDER = ['기초 인지', '수 개념', '수 관계', '덧셈 전 개념', '연산'];

  // 서브앱 index.html은 쉘의 ?v=N과 별개로 캐시되므로 iframe URL에도 버전 파라미터를 붙임
  var SUBAPP_VERSION = '59';
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
      return { category: c, apps: map[c] };
    });
  }

  global.SM_APPS = APPS;
  global.SM_APPS_GROUPED = grouped;
  global.SM_APP_PATH = path;
  global.SM_FIND_APP = find;
})(window);
