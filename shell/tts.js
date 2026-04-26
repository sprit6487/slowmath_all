/**
 * 슬로매스 통합 TTS — Google Cloud TTS (Chirp3-HD-Kore) + localStorage 캐시 + speechSynthesis 폴백.
 *
 * 사용법:
 *   <script src="../shell/tts.js"></script>
 * 만 추가하면 기존 코드의 window.speechSynthesis.speak(utterance) 호출이
 * 자동으로 Google Cloud TTS로 우회됩니다 (monkey-patch).
 *
 * 보안 주의: API 키는 클라이언트에 노출됩니다.
 * GCP Console > APIs & Services > Credentials에서 다음 제한 설정 권장:
 *   - Application restrictions: HTTP referrers (slowkids.net, localhost 등만 허용)
 *   - API restrictions: Cloud Text-to-Speech API만 허용
 *   - Quotas: 일일 한도 설정으로 폭주 방지
 */
(function (global) {
    var API_KEY = 'AIzaSyCnxUTgUZ7ddYAq8s7OTc0TxioHhxsR1yA';
    var VOICE_NAME = 'ko-KR-Chirp3-HD-Kore';
    var LANGUAGE_CODE = 'ko-KR';
    var ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize?key=' + API_KEY;

    var CACHE_PREFIX = 'sm_tts_v2_'; // v1 = ElevenLabs (폐기), v2 = Google Cloud
    var CACHE_LIMIT = 80;
    var RATE_LIMIT_KEY = 'sm_tts_rate_limit';
    var DAILY_API_CALL_LIMIT = 1000; // 일일 캐시 미스(실 API 호출) 한도

    var memCache = {};
    var currentAudio = null;
    var currentAudioStart = 0;     // 재생 시작 시각 (Date.now), 경과 시간 추적용
    var audioUnlocked = false;
    var pendingNext = null;        // 큐잉된 다음 speak (length 1)
    var fetchToken = 0;            // race condition 방지: 새 호출 시마다 증가
    var QUEUE_THRESHOLD_MS = 350;  // 진행 중 음성의 남은 시간이 이 값 미만이면 큐잉
    var MIN_PROTECT_MS = 1500;     // 재생 시작 후 이 시간 이내엔 무조건 큐잉 (짧은 피드백 보호)

    function cacheKey(text) {
        try {
            return CACHE_PREFIX + btoa(unescape(encodeURIComponent(text))).replace(/=+$/, '');
        } catch (e) {
            return CACHE_PREFIX + text.length + '_' + text.charCodeAt(0);
        }
    }

    function readCache(text) {
        if (memCache[text]) return memCache[text];
        try {
            var v = localStorage.getItem(cacheKey(text));
            if (v) { memCache[text] = v; return v; }
        } catch (e) {}
        return null;
    }

    function writeCache(text, dataUrl) {
        memCache[text] = dataUrl;
        try {
            localStorage.setItem(cacheKey(text), dataUrl);
            var keys = [];
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (k && k.indexOf(CACHE_PREFIX) === 0) keys.push(k);
            }
            if (keys.length > CACHE_LIMIT) {
                var overflow = keys.length - CACHE_LIMIT;
                for (var j = 0; j < overflow; j++) {
                    try { localStorage.removeItem(keys[j]); } catch (e) {}
                }
            }
        } catch (e) {
            try {
                var ks = [];
                for (var i = 0; i < localStorage.length; i++) {
                    var kk = localStorage.key(i);
                    if (kk && kk.indexOf(CACHE_PREFIX) === 0) ks.push(kk);
                }
                for (var j = 0; j < Math.floor(ks.length / 2); j++) {
                    try { localStorage.removeItem(ks[j]); } catch (e) {}
                }
                localStorage.setItem(cacheKey(text), dataUrl);
            } catch (e2) {}
        }
    }

    // ── 첫 로드 시 v1 (ElevenLabs) 캐시 정리 ──
    try {
        var v1Keys = [];
        for (var i = 0; i < localStorage.length; i++) {
            var key = localStorage.key(i);
            if (key && key.indexOf('sm_tts_v1_') === 0) v1Keys.push(key);
        }
        v1Keys.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
    } catch (e) {}

    // 일일 API 호출 카운터 (캐시 미스만 카운트) — 키 도용/폭주 방지 안전망
    function _today() { return new Date().toISOString().slice(0, 10); }
    function readRateState() {
        try {
            var v = localStorage.getItem(RATE_LIMIT_KEY);
            if (v) {
                var s = JSON.parse(v);
                if (s.date === _today()) return s;
            }
        } catch (e) {}
        return { date: _today(), count: 0 };
    }
    function bumpRateCount() {
        var s = readRateState();
        s.count++;
        try { localStorage.setItem(RATE_LIMIT_KEY, JSON.stringify(s)); } catch (e) {}
        return s.count;
    }
    function rateLimitExceeded() {
        return readRateState().count >= DAILY_API_CALL_LIMIT;
    }

    function fetchTTS(text) {
        return fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                input: { text: text },
                voice: { languageCode: LANGUAGE_CODE, name: VOICE_NAME },
                audioConfig: { audioEncoding: 'MP3' }
            })
        }).then(function (res) {
            if (!res.ok) throw new Error('TTS API ' + res.status);
            return res.json();
        }).then(function (data) {
            if (!data.audioContent) throw new Error('No audioContent in response');
            return 'data:audio/mp3;base64,' + data.audioContent;
        });
    }

    function unlockAudio() {
        if (audioUnlocked) return;
        audioUnlocked = true;
        try {
            var a = new Audio('data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQwAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OF6zM82DWbZaUmMBptgQhGjsyYqc9ae9XFz280948NMBWInljyzsNRFLPWdnZGWrddDsjK1unuSrVN9jJsK8KuQtQCtMBjCEtImISdNKJOopIpBFpNSMbIHCSRpRR5iakjTiyzLhchUUBwCgyKiweBv/7UsQbg8isVK7N0PmgAAA0gAAABEVFGmgqK////9bP/6XCykxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq');
            a.volume = 0;
            var p = a.play();
            if (p && p.catch) p.catch(function () {});
        } catch (e) {}
    }

    function cancel() {
        pendingNext = null;
        fetchToken++; // 진행 중 fetch 결과 무효화
        if (currentAudio) {
            try { currentAudio.pause(); currentAudio.src = ''; } catch (e) {}
            currentAudio = null;
        }
        if (global.speechSynthesis && _origCancel) {
            try { _origCancel.call(global.speechSynthesis); } catch (e) {}
        }
    }

    function fallbackSpeak(text, opts) {
        if (!global.speechSynthesis || !_origSpeak) return;
        try { _origCancel.call(global.speechSynthesis); } catch (e) {}
        var u = new SpeechSynthesisUtterance(text);
        u.lang = 'ko-KR';
        u.rate = (opts && opts.rate) || 1.0;
        u.pitch = (opts && opts.pitch) || 1.0;
        setTimeout(function () {
            try { _origSpeak.call(global.speechSynthesis, u); } catch (e) {}
        }, 50);
    }

    function speak(text, opts) {
        if (!text || typeof text !== 'string' || !text.trim()) return;
        // 진행 중 음성이 있으면 큐잉 여부 판단 — 짧은 피드백("정답이에요" 등)이 잘리지 않게 보호
        if (currentAudio && !currentAudio.paused && !currentAudio.ended) {
            var elapsed = Date.now() - currentAudioStart;
            var dur = currentAudio.duration;
            var remaining = (isFinite(dur) && dur > 0) ? (dur - currentAudio.currentTime) * 1000 : null;
            // 큐잉 조건: (1) 재생 시작 후 1.5초 이내 또는 (2) 남은 시간 < 350ms
            var shouldQueue = (elapsed < MIN_PROTECT_MS) ||
                              (remaining !== null && remaining > 0 && remaining < QUEUE_THRESHOLD_MS);
            if (shouldQueue) {
                pendingNext = { text: text, opts: opts };
                currentAudio.addEventListener('ended', _flushPending, { once: true });
                return;
            }
        }
        _doSpeak(text, opts);
    }

    function _flushPending() {
        if (!pendingNext) return;
        var p = pendingNext;
        pendingNext = null;
        _doSpeak(p.text, p.opts);
    }

    function _doSpeak(text, opts) {
        // 진행 중 audio가 있으면 (아직 안 끝났음) cancel — 그러나 token만 무효화 (pendingNext는 그대로)
        if (currentAudio) {
            try { currentAudio.pause(); currentAudio.src = ''; } catch (e) {}
            currentAudio = null;
        }
        if (global.speechSynthesis && _origCancel) {
            try { _origCancel.call(global.speechSynthesis); } catch (e) {}
        }
        fetchToken++;
        var myToken = fetchToken;
        var cached = readCache(text);
        if (cached) {
            playDataUrl(cached, opts);
            return;
        }
        if (rateLimitExceeded()) {
            if (global.console) console.warn('[SM_TTS] daily API limit (' + DAILY_API_CALL_LIMIT + ') reached, fallback');
            fallbackSpeak(text, opts);
            return;
        }
        bumpRateCount();
        fetchTTS(text).then(function (dataUrl) {
            if (myToken !== fetchToken) return; // 더 새 호출이 있었으면 무시
            writeCache(text, dataUrl);
            playDataUrl(dataUrl, opts);
        }).catch(function (err) {
            if (myToken !== fetchToken) return;
            if (global.console) console.warn('[SM_TTS] fallback:', err);
            fallbackSpeak(text, opts);
        });
    }

    // 자주 쓰는 문구를 백그라운드로 미리 합성·캐시 → 첫 재생도 즉시
    function prewarm(texts) {
        if (!Array.isArray(texts)) return;
        texts.forEach(function (text, i) {
            if (!text || typeof text !== 'string' || !text.trim()) return;
            if (readCache(text)) return; // 이미 캐시됨
            // 200ms 간격으로 분산 (UI 첫 페인트 방해 안 하도록)
            setTimeout(function () {
                if (readCache(text)) return;
                if (rateLimitExceeded()) return;
                bumpRateCount();
                fetchTTS(text).then(function (dataUrl) {
                    writeCache(text, dataUrl);
                }).catch(function () {});
            }, 100 + i * 200);
        });
    }

    function playDataUrl(dataUrl, opts) {
        try {
            var audio = new Audio(dataUrl);
            audio.playbackRate = (opts && opts.rate) || 1.0;
            currentAudio = audio;
            currentAudioStart = Date.now();
            var p = audio.play();
            if (p && p.catch) p.catch(function (err) {
                if (global.console) console.warn('[SM_TTS] play failed:', err);
            });
        } catch (e) {
            if (global.console) console.warn('[SM_TTS] play exception:', e);
        }
    }

    var _unlockOnce = function () {
        unlockAudio();
        document.removeEventListener('click', _unlockOnce, true);
        document.removeEventListener('touchstart', _unlockOnce, true);
        document.removeEventListener('keydown', _unlockOnce, true);
    };
    document.addEventListener('click', _unlockOnce, true);
    document.addEventListener('touchstart', _unlockOnce, true);
    document.addEventListener('keydown', _unlockOnce, true);

    // ── speechSynthesis API monkey-patch ──
    var _origSpeak = null, _origCancel = null;
    if (global.speechSynthesis && global.SpeechSynthesisUtterance) {
        _origSpeak = global.speechSynthesis.speak.bind(global.speechSynthesis);
        _origCancel = global.speechSynthesis.cancel.bind(global.speechSynthesis);
        global.speechSynthesis.speak = function (utterance) {
            if (!utterance) return;
            var text = utterance.text;
            if (!text || !text.trim()) {
                unlockAudio();
                return;
            }
            speak(text, { rate: utterance.rate || 1.0, pitch: utterance.pitch || 1.0 });
        };
        global.speechSynthesis.cancel = function () {
            // 짧은 피드백("정답이에요" 등) 보호 — 재생 시작 후 1.5초 이내면 cancel 무시
            // (서브앱의 speak() 함수는 보통 cancel() 직후 새 speak()를 호출하는데,
            // cancel을 즉시 실행하면 진행 중 음성이 잘림. 큐잉 로직이 처리하도록 위임)
            if (currentAudio && !currentAudio.paused && !currentAudio.ended) {
                var elapsed = Date.now() - currentAudioStart;
                if (elapsed < MIN_PROTECT_MS) return;
            }
            cancel();
        };
    }

    global.SM_TTS = {
        speak: speak,
        cancel: cancel,
        prewarm: prewarm,
        unlock: unlockAudio
    };

    // ── 모든 서브앱이 공통으로 쓰는 짧은 피드백 자동 prewarm ──
    // 각 서브앱은 자기만의 질문/안내 문구만 별도 prewarm 호출하면 됨
    prewarm([
        // 정답 피드백
        '정답', '정답!', '정답이에요', '정답이에요.', '정답이에요!', '정답입니다.',
        // 오답 피드백
        '다시 해봐요', '다시 해봐요.', '다시 해봐요!', '다시 골라보세요', '아니에요.',
        // 칭찬/완료
        '잘했어요!', '완벽해요!', '모두 풀었어요! 잘했어요!', '연습 완료! 잘했어요!',
        // 패스
        '패스합니다.'
    ]);
})(window);
