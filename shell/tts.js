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
    var audioUnlocked = false;

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
        cancel();
        var cached = readCache(text);
        if (cached) {
            playDataUrl(cached, opts);
            return;
        }
        // 캐시 미스 — 일일 한도 체크
        if (rateLimitExceeded()) {
            if (global.console) console.warn('[SM_TTS] daily API limit (' + DAILY_API_CALL_LIMIT + ') reached, fallback');
            fallbackSpeak(text, opts);
            return;
        }
        bumpRateCount();
        fetchTTS(text).then(function (dataUrl) {
            writeCache(text, dataUrl);
            playDataUrl(dataUrl, opts);
        }).catch(function (err) {
            if (global.console) console.warn('[SM_TTS] fallback:', err);
            fallbackSpeak(text, opts);
        });
    }

    function playDataUrl(dataUrl, opts) {
        try {
            var audio = new Audio(dataUrl);
            audio.playbackRate = (opts && opts.rate) || 1.0;
            currentAudio = audio;
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
            cancel();
        };
    }

    global.SM_TTS = {
        speak: speak,
        cancel: cancel,
        unlock: unlockAudio
    };
})(window);
