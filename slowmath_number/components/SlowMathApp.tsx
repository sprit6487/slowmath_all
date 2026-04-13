'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

// ── Types ──────────────────────────────────────────────────────
type View = 'login' | 'start' | 'game' | 'quiz' | 'wrongNotes' | 'result'
type GameMode = 'game' | 'quiz' | 'fill' | null
type CountingMode = 'sino' | 'native'
type ImpulseMode = 'hide' | 'lock'

interface ChipData { num: number; x: number; y: number; placed: boolean; isDragging: boolean }
interface SlotData { num: number; filled: boolean; wrong: boolean; hint: boolean }
interface QuizCardData { num: number; hidden: boolean; filled: boolean; wrong: boolean }
interface QuizChipData { num: number; placed: boolean; isDragging: boolean }

// ── Constants ──────────────────────────────────────────────────
const FILL_HINTS: Record<number, number> = { 5: 2, 10: 3, 20: 6, 30: 9, 50: 15, 100: 15 }
const QUIZ_TOTAL = 5

const SM_RECO = [
  { title: '숫자 쓰기', emoji: '✏️', url: 'https://sprit6487.github.io/slowmath_numberdraw/', desc: '숫자를 따라 써보세요!' },
  { title: '숫자 매칭', emoji: '🎯', url: 'https://sprit6487.github.io/slowmath_matching/', desc: '숫자를 보고, 동그라미를 옮겨보세요' },
  { title: '세기', emoji: '🎲', url: 'https://sprit6487.github.io/slowmath_dice/', desc: '손가락, 주사위, 카드를 세어보세요' },
]

// ── Pure helpers ───────────────────────────────────────────────
function nativeKorean(n: number): string {
  if (n === 100) return '백'
  const ones = ['', '하나', '둘', '셋', '넷', '다섯', '여섯', '일곱', '여덟', '아홉']
  const tens = ['', '열', '스물', '서른', '마흔', '쉰', '예순', '일흔', '여든', '아흔']
  return tens[Math.floor(n / 10)] + ones[n % 10]
}

function sinoKorean(n: number): string {
  if (n === 100) return '백'
  const ones = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구']
  if (n <= 0) return ''
  const t = Math.floor(n / 10), o = n % 10
  let r = ''
  if (t >= 2) r += ones[t]
  if (t >= 1) r += '십'
  r += ones[o]
  return r
}

function nativeNum(n: number): string {
  const w = ['', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열']
  return w[n] || String(n)
}

function shuffleArr<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function scatterPositions(count: number, areaW: number, areaH: number, chipSize: number) {
  const gap = Math.round(chipSize * 0.3)
  const cell = chipSize + gap
  const cols = Math.max(1, Math.floor(areaW / cell))
  const rows = Math.ceil(count / cols)
  const cells: { x: number; y: number }[] = []
  for (let r = 0; r < rows; r++) {
    const itemsInRow = r < rows - 1 ? cols : count - r * cols
    const rowW = itemsInRow * cell - gap
    const startX = Math.max(0, (areaW - rowW) / 2)
    for (let c = 0; c < itemsInRow; c++) cells.push({ x: startX + c * cell, y: r * cell })
  }
  const shuffled = shuffleArr(cells)
  const jitter = Math.floor(gap * 0.3)
  return shuffled.map(p => ({
    x: p.x + (Math.random() * 2 - 1) * jitter,
    y: p.y + (Math.random() * 2 - 1) * jitter,
  }))
}

// ── Logo SVG (reused in splash/login/start) ───────────────────
function LogoSVG({ width = 120, height = 100 }: { width?: number; height?: number }) {
  return (
    <svg viewBox="0 0 120 100" width={width} height={height} fill="none" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="30" cy="72" rx="10" ry="6" fill="#F2DC8C" stroke="#3A9B6A" strokeWidth="2" transform="rotate(-20 30 72)"/>
      <ellipse cx="78" cy="76" rx="10" ry="6" fill="#F2DC8C" stroke="#3A9B6A" strokeWidth="2" transform="rotate(15 78 76)"/>
      <ellipse cx="28" cy="54" rx="9" ry="5.5" fill="#F2DC8C" stroke="#3A9B6A" strokeWidth="2" transform="rotate(-10 28 54)"/>
      <path d="M18 60 L10 55" stroke="#F2DC8C" strokeWidth="4" strokeLinecap="round"/>
      <ellipse cx="55" cy="58" rx="35" ry="20" fill="#F5E6C8" stroke="#3A9B6A" strokeWidth="2"/>
      <ellipse cx="52" cy="42" rx="32" ry="28" fill="#7EDCAA" stroke="#3A9B6A" strokeWidth="2.5"/>
      <path d="M52 18 L42 32 L42 48 L52 58 L62 48 L62 32 Z" fill="none" stroke="#3A9B6A" strokeWidth="1.3" opacity=".35"/>
      <line x1="42" y1="32" x2="24" y2="38" stroke="#3A9B6A" strokeWidth="1.3" opacity=".35"/>
      <line x1="62" y1="32" x2="80" y2="38" stroke="#3A9B6A" strokeWidth="1.3" opacity=".35"/>
      <line x1="42" y1="48" x2="26" y2="56" stroke="#3A9B6A" strokeWidth="1.3" opacity=".35"/>
      <line x1="62" y1="48" x2="78" y2="56" stroke="#3A9B6A" strokeWidth="1.3" opacity=".35"/>
      <ellipse cx="42" cy="26" rx="6" ry="4" fill="white" opacity=".35" transform="rotate(-15 42 26)"/>
      <ellipse cx="62" cy="36" rx="4" ry="3" fill="white" opacity=".2"/>
      <ellipse cx="92" cy="40" rx="17" ry="15" fill="#F5E6C8" stroke="#3A9B6A" strokeWidth="2.5"/>
      <ellipse cx="82" cy="72" rx="10" ry="6" fill="#F2DC8C" stroke="#3A9B6A" strokeWidth="2" transform="rotate(10 82 72)"/>
      <circle cx="99" cy="35" r="4" fill="white" stroke="#3A9B6A" strokeWidth="1.5"/>
      <circle cx="100" cy="34" r="2.5" fill="#3A9B6A"/>
      <circle cx="101" cy="33" r="1" fill="white"/>
      <circle cx="100" cy="44" r="3.5" fill="#F0A050" opacity=".4"/>
      <path d="M94 46 Q98 50 103 46" fill="none" stroke="#3A9B6A" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

// ── Main Component ─────────────────────────────────────────────
export default function SlowMathApp() {
  // View
  const [view, setView] = useState<View>('start')
  const [showSplash, setShowSplash] = useState(true)
  const [splashFading, setSplashFading] = useState(false)

  // Auth
  const [isLoggedIn, setIsLoggedIn] = useState(false)

  // Settings
  const [ttsEnabled, setTtsEnabled] = useState(true)
  const [impulsePrevention, setImpulsePrevention] = useState(true)
  const [impulseMode, setImpulseMode] = useState<ImpulseMode>('hide')
  const [impulseDelay, setImpulseDelay] = useState(5)
  const [countingMode, setCountingMode] = useState<CountingMode>('sino')
  const [reverseMode, setReverseMode] = useState(false)
  const [ghostMode, setGhostMode] = useState(false)

  // Game state
  const [gameMode, setGameMode] = useState<GameMode>(null)
  const [maxNum, setMaxNum] = useState(10)
  const [startNum, setStartNum] = useState(1)
  const [lastRange, setLastRange] = useState(10)
  const [lastStart, setLastStart] = useState(1)
  const [placedCount, setPlacedCount] = useState(0)
  const [wrongCount, setWrongCount] = useState(0)
  const [fillTotal, setFillTotal] = useState(0)
  const [chips, setChips] = useState<ChipData[]>([])
  const [slots, setSlots] = useState<SlotData[]>([])
  const [chipPx, setChipPx] = useState(36)
  const [scatterH, setScatterH] = useState(220)
  const [feedback, setFeedback] = useState('')
  const [feedbackColor, setFeedbackColor] = useState('#4A4035')
  const [hintText, setHintText] = useState('')
  const [hintColor, setHintColor] = useState('#6BADE8')
  const [gameLabel, setGameLabel] = useState('')
  const startTimeRef = useRef(0)
  const gameModeRef = useRef<GameMode>(null)
  const maxNumRef = useRef(10)
  const startNumRef = useRef(1)
  const reverseModeRef = useRef(false)
  const fillTotalRef = useRef(0)

  // Impulse UI
  const [chipsHidden, setChipsHidden] = useState(false)
  const [chipsLocked, setChipsLocked] = useState(false)
  const [impulseCountdown, setImpulseCountdown] = useState<number | null>(null)
  const impulseTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Quiz state
  const [quizRound, setQuizRound] = useState(0)
  const [quizTotalRounds, setQuizTotalRounds] = useState(QUIZ_TOTAL)
  const [quizCorrect, setQuizCorrect] = useState(0)
  const [quizCards, setQuizCards] = useState<QuizCardData[]>([])
  const [quizChips, setQuizChips] = useState<QuizChipData[]>([])
  const [quizFeedback, setQuizFeedback] = useState('')
  const [quizFeedbackColor, setQuizFeedbackColor] = useState('#4A4035')
  const [quizHintText, setQuizHintText] = useState('숨은 숫자를 찾아서 빈칸에 놓아봐요')
  const [quizHintColor, setQuizHintColor] = useState('#6BADE8')
  const [showQuizNextBtn, setShowQuizNextBtn] = useState(false)
  const [quizLabel, setQuizLabel] = useState('문제 1 / 5')
  const [quizProgressPct, setQuizProgressPct] = useState(0)
  const [quizCardLayout, setQuizCardLayout] = useState(5)

  // Quiz refs (mutable state for drag logic)
  const quizRoundRef = useRef(0)
  const quizTotalRoundsRef = useRef(QUIZ_TOTAL)
  const quizCorrectRef = useRef(0)
  const quizWrongRef = useRef(0)
  const quizStartTimeRef = useRef(0)
  const quizHiddenOrderRef = useRef<number[]>([])
  const quizPlacedInRoundRef = useRef(0)
  const quizFirstTryRef = useRef(true)
  const quizRangeRef = useRef(10)
  const quizNextFnRef = useRef<(() => void) | null>(null)
  const isWnPracticeRef = useRef(false)
  const wnChunksRef = useRef<number[][]>([])
  const wnRoundIdxRef = useRef(0)

  // Result state
  const [resultEmoji, setResultEmoji] = useState('🏆')
  const [resultMsg, setResultMsg] = useState('완료!')
  const [resultSub, setResultSub] = useState('')
  const lastGameCompletedRef = useRef(false)

  // Wrong notes
  const [wrongNotes, setWrongNotesState] = useState<number[]>([])

  // Reco popup
  const [recoVisible, setRecoVisible] = useState(false)
  const [recoItem, setRecoItem] = useState(SM_RECO[0])

  // Share toast
  const [shareToast, setShareToast] = useState('')
  const [shareToastVisible, setShareToastVisible] = useState(false)
  const shareToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Drag state (refs to avoid stale closures in event handlers)
  const isDraggingRef = useRef(false)
  const dragValueRef = useRef<number | null>(null)
  const dragChipIndexRef = useRef<number | null>(null) // index in chips/quizChips
  const isDragQuizRef = useRef(false)
  const floatingRef = useRef<HTMLDivElement | null>(null)
  const currentChipPxRef = useRef(36)

  // DOM refs
  const slotElemsRef = useRef<Map<number, HTMLDivElement>>(new Map())
  const quizCardElemsRef = useRef<Map<number, HTMLDivElement>>(new Map())
  const chipContainerRef = useRef<HTMLDivElement>(null)

  // Pending game setup (set before view transitions so we can calculate after render)
  const pendingSetupRef = useRef<{
    nums: number[]
    slots: SlotData[]
    chipPx: number
    scatterH: number
    areaW: number
    mode: 'game' | 'fill'
    fillTotalVal: number
    maxNumVal: number
    startNumVal: number
    reverseVal: boolean
    labelText: string
    hintMsg: string
  } | null>(null)

  // ── Helpers ────────────────────────────────────────────────
  const countingWord = useCallback((n: number, mode: CountingMode) =>
    mode === 'native' ? nativeKorean(n) : sinoKorean(n), [])

  const speak = useCallback((text: string, tts: boolean) => {
    if (!tts || typeof window === 'undefined' || !window.speechSynthesis) return
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'ko-KR'; u.rate = 0.9
    setTimeout(() => window.speechSynthesis.speak(u), 50)
  }, [])

  // ── Wrong notes helpers ────────────────────────────────────
  const getWrongNotes = useCallback((): number[] => {
    try {
      const data = JSON.parse(localStorage.getItem('slowmath_number_wrong_notes') || '[]')
      if (Array.isArray(data)) {
        // Support both old {number} format and plain number
        return data.map((x: unknown) => typeof x === 'number' ? x : (x as {number: number}).number)
      }
    } catch { /* empty */ }
    return []
  }, [])

  const saveWrongNotes = useCallback((notes: number[]) => {
    localStorage.setItem('slowmath_number_wrong_notes', JSON.stringify(notes))
    setWrongNotesState(notes)
  }, [])

  const addWrongNote = useCallback((n: number) => {
    const notes = JSON.parse(localStorage.getItem('slowmath_number_wrong_notes') || '[]')
    const nums: number[] = Array.isArray(notes)
      ? notes.map((x: unknown) => typeof x === 'number' ? x : (x as {number: number}).number)
      : []
    if (!nums.includes(n)) saveWrongNotes([...nums, n])
  }, [saveWrongNotes])

  const removeWrongNote = useCallback((n: number) => {
    const notes = getWrongNotes().filter(x => x !== n)
    saveWrongNotes(notes)
  }, [getWrongNotes, saveWrongNotes])

  // ── Settings persistence ────────────────────────────────────
  const saveSettings = useCallback((s: {
    ttsEnabled: boolean; impulsePrevention: boolean; impulseMode: ImpulseMode
    impulseDelay: number; countingMode: CountingMode; reverseMode: boolean; ghostMode: boolean
  }) => {
    localStorage.setItem('slowmath_number_settings', JSON.stringify(s))
  }, [])

  // ── Impulse control ────────────────────────────────────────
  const clearImpulse = useCallback(() => {
    if (impulseTimerRef.current) { clearInterval(impulseTimerRef.current); impulseTimerRef.current = null }
    setChipsHidden(false)
    setChipsLocked(false)
    setImpulseCountdown(null)
  }, [])

  const applyImpulse = useCallback((prevention: boolean, mode: ImpulseMode, delay: number) => {
    if (!prevention) return
    if (mode === 'hide') {
      setChipsHidden(true)
    } else {
      setChipsLocked(true)
      let remaining = delay
      setImpulseCountdown(remaining)
      impulseTimerRef.current = setInterval(() => {
        remaining--
        if (remaining <= 0) {
          clearInterval(impulseTimerRef.current!)
          impulseTimerRef.current = null
          setChipsLocked(false)
          setImpulseCountdown(null)
        } else {
          setImpulseCountdown(remaining)
        }
      }, 1000)
    }
  }, [])

  // ── TTS init ────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.getVoices()
      if (window.speechSynthesis.onvoiceschanged !== undefined)
        window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices()
    }
  }, [])

  // ── Init on mount ──────────────────────────────────────────
  useEffect(() => {
    // Load settings
    try {
      const s = JSON.parse(localStorage.getItem('slowmath_number_settings') || '{}')
      if (typeof s.ttsEnabled === 'boolean') setTtsEnabled(s.ttsEnabled)
      if (typeof s.impulsePrevention === 'boolean') setImpulsePrevention(s.impulsePrevention)
      if (s.impulseMode === 'hide' || s.impulseMode === 'lock') setImpulseMode(s.impulseMode)
      if (typeof s.impulseDelay === 'number') setImpulseDelay(s.impulseDelay)
      if (s.countingMode === 'native' || s.countingMode === 'sino') setCountingMode(s.countingMode)
      if (typeof s.reverseMode === 'boolean') setReverseMode(s.reverseMode)
      if (typeof s.ghostMode === 'boolean') setGhostMode(s.ghostMode)
    } catch { /* empty */ }

    // Load wrong notes
    setWrongNotesState(getWrongNotes())

    // Check login
    setIsLoggedIn(!!localStorage.getItem('slowmath_number_login'))

    // Share bubble
    const days = parseInt(localStorage.getItem('slowmath_share_days') || '0')
    if (days >= 5) {
      // hide share bubble (handled via isLoggedIn check anyway)
    }

    // Splash
    const t1 = setTimeout(() => setSplashFading(true), 3000)
    const t2 = setTimeout(() => setShowSplash(false), 3500)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [getWrongNotes])

  // ── Chip position calculation after game view renders ───────
  useEffect(() => {
    if (view !== 'game' || !pendingSetupRef.current || !chipContainerRef.current) return
    const setup = pendingSetupRef.current
    pendingSetupRef.current = null

    const areaW = chipContainerRef.current.offsetWidth || setup.areaW
    const { nums, slots: slotData, chipPx: cpx, mode, fillTotalVal, maxNumVal, startNumVal, reverseVal, labelText, hintMsg } = setup

    // Recalculate scatter height based on real width
    const gap = Math.round(cpx * 0.3)
    const cellSize = cpx + gap
    const cols = Math.max(1, Math.floor(areaW / cellSize))
    const totalRows = Math.ceil(nums.length / cols)
    const sh = totalRows * cellSize

    const positions = scatterPositions(nums.length, areaW, sh, cpx)
    const chipData: ChipData[] = nums.map((n, i) => ({
      num: n, x: positions[i].x, y: positions[i].y, placed: false, isDragging: false
    }))

    setChips(chipData)
    setSlots(slotData)
    setScatterH(sh)
    setChipPx(cpx)
    currentChipPxRef.current = cpx
    setGameMode(mode)
    gameModeRef.current = mode
    setMaxNum(maxNumVal)
    maxNumRef.current = maxNumVal
    setStartNum(startNumVal)
    startNumRef.current = startNumVal
    reverseModeRef.current = reverseVal
    fillTotalRef.current = fillTotalVal
    setFillTotal(fillTotalVal)
    setGameLabel(labelText)
    setHintText(hintMsg)
    setHintColor('#6BADE8')
    setPlacedCount(0)
    setWrongCount(0)
    setFeedback('')

    // Clear impulse UI and re-apply
    clearImpulse()
    applyImpulse(impulsePrevention, impulseMode, impulseDelay)
  })

  // ── Game start functions ────────────────────────────────────
  const startGame = useCallback((range: number, start: number = 1) => {
    if (!localStorage.getItem('slowmath_number_login')) {
      sessionStorage.setItem('_sp', JSON.stringify([range, start]))
      setView('login')
      return
    }

    lastGameCompletedRef.current = false
    setLastRange(range)
    setLastStart(start)
    startTimeRef.current = Date.now()

    const isTablet = typeof window !== 'undefined' && window.innerWidth >= 768
    const areaW = isTablet ? 600 : Math.min((typeof window !== 'undefined' ? window.innerWidth : 400) - 32, 568)
    const count = range - start + 1
    const availH = Math.max(120, (typeof window !== 'undefined' ? window.innerHeight : 700) * 0.45)

    function neededH(px: number) {
      const cell = px * 1.3
      const cols = Math.max(1, Math.floor(areaW / cell))
      return Math.ceil(count / cols) * cell
    }
    const maxCpx = isTablet ? 88 : 72
    const minCpx = isTablet ? 26 : 22
    let cpx = maxCpx
    while (cpx > minCpx && neededH(cpx) > availH) cpx -= 2

    const gap = Math.round(cpx * 0.3)
    const cellSize = cpx + gap
    const cols = Math.max(1, Math.floor(areaW / cellSize))
    const totalRows = Math.ceil(count / cols)
    const sh = totalRows * cellSize

    // Build slots
    const slotData: SlotData[] = []
    for (let idx = 0; idx < count; idx++) {
      const n = reverseMode ? range - idx : start + idx
      slotData.push({ num: n, filled: false, wrong: false, hint: false })
    }

    // Shuffled chip numbers
    const nums = shuffleArr(Array.from({ length: count }, (_, i) => start + i))
    const label = reverseMode ? `${range} → ${start} 역순` : `${start} ~ ${range}`

    pendingSetupRef.current = {
      nums, slots: slotData, chipPx: cpx, scatterH: sh, areaW,
      mode: 'game', fillTotalVal: 0, maxNumVal: range, startNumVal: start,
      reverseVal: reverseMode, labelText: label, hintMsg: '',
    }
    slotElemsRef.current.clear()
    setView('game')

    if (typeof window !== 'undefined' && window.speechSynthesis)
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(''))
    setTimeout(() => speak('천천히 생각하고 풀어보세요.', ttsEnabled), 300)
  }, [reverseMode, ttsEnabled, speak])

  const startFillGame = useCallback((range: number, start: number = 1) => {
    if (!localStorage.getItem('slowmath_number_login')) {
      sessionStorage.setItem('_sp', JSON.stringify(['fill', range, start]))
      setView('login')
      return
    }

    lastGameCompletedRef.current = false
    setLastRange(range)
    setLastStart(start)
    startTimeRef.current = Date.now()

    const totalCount = range - start + 1
    const hintCount = FILL_HINTS[totalCount] ?? Math.round(totalCount * 0.3)
    const fillTotalVal = totalCount - hintCount

    const allNums = Array.from({ length: totalCount }, (_, i) => start + i)
    const shuffledForHint = shuffleArr(allNums)
    const prefilledSet = new Set(shuffledForHint.slice(0, hintCount))

    const slotData: SlotData[] = allNums.map(n => ({
      num: n,
      filled: prefilledSet.has(n),
      wrong: false,
      hint: prefilledSet.has(n),
    }))

    const chipNums = shuffleArr(allNums.filter(n => !prefilledSet.has(n)))

    const isTablet = typeof window !== 'undefined' && window.innerWidth >= 768
    const areaW = isTablet ? 600 : Math.min((typeof window !== 'undefined' ? window.innerWidth : 400) - 32, 568)
    const cpx = isTablet ? 44 : 36
    const gap = Math.round(cpx * 0.3)
    const cellSize = cpx + gap
    const cols = Math.max(1, Math.floor(areaW / cellSize))
    const totalRows = Math.ceil(chipNums.length / cols)
    const sh = totalRows * cellSize

    pendingSetupRef.current = {
      nums: chipNums, slots: slotData, chipPx: cpx, scatterH: sh, areaW,
      mode: 'fill', fillTotalVal, maxNumVal: range, startNumVal: start,
      reverseVal: false, labelText: `${start} ~ ${range} (${hintCount}개 힌트)`,
      hintMsg: `${fillTotalVal}개 남았어요`,
    }
    slotElemsRef.current.clear()
    setView('game')

    if (typeof window !== 'undefined' && window.speechSynthesis)
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(''))
    setTimeout(() => speak('힌트를 보고 나머지를 채워봐요.', ttsEnabled), 300)
  }, [ttsEnabled, speak])

  // ── Game place number ──────────────────────────────────────
  const placeNumberInGame = useCallback((slotIdx: number, chipIdx: number, value: number) => {
    setSlots(prev => prev.map((s, i) => i === slotIdx ? { ...s, filled: true, wrong: false } : s))
    setChips(prev => prev.map((c, i) => i === chipIdx ? { ...c, placed: true, isDragging: false } : { ...c, isDragging: false }))

    setPlacedCount(prev => {
      const next = prev + 1
      const total = gameModeRef.current === 'fill' ? fillTotalRef.current : (maxNumRef.current - startNumRef.current + 1)
      const pct = Math.round((next / total) * 100)
      // Update progress label via state is handled in JSX

      if (next >= total) {
        setFeedback('완성! 🎉')
        setFeedbackColor('#5BC886')
        setHintText('완성!')
        setHintColor('#5BC886')
        speak('다 맞혔어요! 정말 잘했어요.', ttsEnabled)
        setTimeout(() => {
          const sec = Math.floor((Date.now() - startTimeRef.current) / 1000)
          const revMode = reverseModeRef.current
          const rangeText = revMode ? `${maxNumRef.current} → ${startNumRef.current} 역순` : `${startNumRef.current} ~ ${maxNumRef.current}`
          // Use wrongCount from closure — use a ref instead
          setResultEmoji(wrongCountRef.current === 0 ? '🏆' : '👏')
          setResultMsg('완료!')
          setResultSub(`범위 ${rangeText} · ${sec}초 · 틀린 횟수 ${wrongCountRef.current}번`)
          lastGameCompletedRef.current = true
          setView('result')
        }, 1500)
      } else {
        setFeedback('잘했어요!')
        setFeedbackColor('#5BC886')
        speak(countingWord(value, countingModeRef.current), ttsEnabled)
        setTimeout(() => setFeedback(prev2 => prev2 === '잘했어요!' ? '' : prev2), 800)

        if (gameModeRef.current === 'fill') {
          const remaining = fillTotalRef.current - next
          setHintText(`${remaining}개 남았어요`)
          setHintColor('#C4AA82')
        }
      }
      return next
    })
  }, [speak, ttsEnabled, countingWord])

  // Refs for values needed in drag handlers
  const wrongCountRef = useRef(0)
  const countingModeRef = useRef<CountingMode>('sino')
  const ttsEnabledRef = useRef(true)

  useEffect(() => { wrongCountRef.current = wrongCount }, [wrongCount])
  useEffect(() => { countingModeRef.current = countingMode }, [countingMode])
  useEffect(() => { ttsEnabledRef.current = ttsEnabled }, [ttsEnabled])

  // ── Drag system ─────────────────────────────────────────────
  const beginDrag = useCallback((chipIndex: number, value: number, x: number, y: number, isQuiz: boolean) => {
    if (isDraggingRef.current) return
    isDraggingRef.current = true
    dragValueRef.current = value
    dragChipIndexRef.current = chipIndex
    isDragQuizRef.current = isQuiz

    if (isQuiz) {
      setQuizChips(prev => prev.map((c, i) => i === chipIndex ? { ...c, isDragging: true } : c))
    } else {
      setChips(prev => prev.map((c, i) => i === chipIndex ? { ...c, isDragging: true } : c))
    }

    // Create floating element
    if (floatingRef.current) floatingRef.current.remove()
    const el = document.createElement('div')
    el.className = 'floating-num'
    el.textContent = String(value)
    const firstSlot = document.querySelector('.slot')
    const sz = firstSlot ? Math.round(firstSlot.getBoundingClientRect().width) : currentChipPxRef.current
    el.style.width = sz + 'px'
    el.style.height = sz + 'px'
    el.style.fontSize = ((sz * 0.38) / 16).toFixed(2) + 'rem'
    el.style.borderRadius = Math.round(sz * 0.3) + 'px'
    el.style.left = x + 'px'
    el.style.top = y + 'px'
    document.body.appendChild(el)
    floatingRef.current = el
  }, [])

  const clearDragHighlights = useCallback(() => {
    document.querySelectorAll('.slot.drag-over, .quiz-card.drag-over').forEach(el => el.classList.remove('drag-over'))
  }, [])

  const getSlotAt = useCallback((x: number, y: number): { idx: number; num: number } | null => {
    for (const [num, el] of slotElemsRef.current) {
      const r = el.getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { idx: 0, num }
    }
    return null
  }, [])

  const getQuizCardAt = useCallback((x: number, y: number): number | null => {
    for (const [num, el] of quizCardElemsRef.current) {
      const r = el.getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return num
    }
    return null
  }, [])

  // End drag for game/fill mode
  const endGameDrag = useCallback((x: number, y: number) => {
    clearDragHighlights()
    const target = getSlotAt(x, y)
    const chipIdx = dragChipIndexRef.current
    const val = dragValueRef.current

    if (target !== null && val !== null && chipIdx !== null) {
      const { num: slotNum } = target
      // Find slot index
      setSlots(prev => {
        const slotIdx = prev.findIndex(s => s.num === slotNum)
        if (slotIdx === -1 || prev[slotIdx].filled) return prev
        if (val === slotNum) {
          // Correct
          placeNumberInGame(slotIdx, chipIdx, val)
          return prev // state updated inside placeNumberInGame
        } else {
          // Wrong
          setWrongCount(c => { wrongCountRef.current = c + 1; return c + 1 })
          addWrongNote(val)
          setFeedback('이 칸은 다른 숫자 자리예요')
          setFeedbackColor('#F07070')
          speak('다시 해봐요.', ttsEnabledRef.current)
          setChips(cp => cp.map((c, i) => i === chipIdx ? { ...c, isDragging: false } : c))
          // Animate wrong slot
          const newSlots = prev.map((s, i) => i === slotIdx ? { ...s, wrong: true } : s)
          setTimeout(() => setSlots(ss => ss.map((s, i) => i === slotIdx ? { ...s, wrong: false } : s)), 400)
          return newSlots
        }
      })
    } else {
      // Dropped nowhere
      setChips(prev => prev.map((c, i) => i === chipIdx ? { ...c, isDragging: false } : c))
    }

    if (floatingRef.current) { floatingRef.current.remove(); floatingRef.current = null }
    isDraggingRef.current = false
    dragValueRef.current = null
    dragChipIndexRef.current = null
  }, [clearDragHighlights, getSlotAt, placeNumberInGame, addWrongNote, speak])

  // End drag for quiz mode
  const endQuizDrag = useCallback((x: number, y: number) => {
    clearDragHighlights()
    const cardNum = getQuizCardAt(x, y)
    const chipIdx = dragChipIndexRef.current
    const val = dragValueRef.current

    if (cardNum !== null && val !== null && chipIdx !== null) {
      if (val === cardNum) {
        // Correct
        setQuizCards(prev => prev.map(c => c.num === cardNum ? { ...c, filled: true, wrong: false } : c))
        setQuizChips(prev => prev.map((c, i) => i === chipIdx ? { ...c, placed: true, isDragging: false } : c))

        // Check if WN practice and remove from wrong notes
        if (isWnPracticeRef.current) removeWrongNote(cardNum)

        quizPlacedInRoundRef.current++

        if (quizPlacedInRoundRef.current >= quizHiddenOrderRef.current.length) {
          // Round complete
          if (quizFirstTryRef.current) {
            quizCorrectRef.current++
            setQuizCorrect(quizCorrectRef.current)
          }
          setQuizProgressPct(Math.round((quizRoundRef.current / quizTotalRoundsRef.current) * 100))
          setQuizFeedback(isWnPracticeRef.current ? '잘했어요! 🎉' : '정답이에요! 🎉')
          setQuizFeedbackColor('#5BC886')
          speak(isWnPracticeRef.current ? '잘했어요.' : '정답이에요.', ttsEnabledRef.current)

          const isLast = isWnPracticeRef.current
            ? wnRoundIdxRef.current >= wnChunksRef.current.length
            : quizRoundRef.current >= quizTotalRoundsRef.current

          if (isLast) {
            setTimeout(() => {
              const sec = Math.floor((Date.now() - quizStartTimeRef.current) / 1000)
              setResultEmoji(quizWrongRef.current === 0 ? '🏆' : '👏')
              setResultMsg('완료!')
              setResultSub(`빈칸 1~${quizRangeRef.current} · ${sec}초 · 틀린 횟수 ${quizWrongRef.current}번`)
              speak(`다 풀었어요. ${nativeNum(quizCorrectRef.current)} 문제 맞혔어요.`, ttsEnabledRef.current)
              lastGameCompletedRef.current = true
              isWnPracticeRef.current = false
              setView('result')
            }, 1500)
          } else {
            setShowQuizNextBtn(true)
            quizNextFnRef.current = isWnPracticeRef.current ? nextWNRound : nextQuizRound
          }
        } else {
          setQuizFeedback('잘했어요!')
          setQuizFeedbackColor('#5BC886')
          speak(String(cardNum), ttsEnabledRef.current)
          setTimeout(() => setQuizFeedback(p => p === '잘했어요!' ? '' : p), 800)
        }
      } else {
        // Wrong
        quizWrongRef.current++
        quizFirstTryRef.current = false
        addWrongNote(val)
        setQuizCards(prev => prev.map(c => c.num === cardNum ? { ...c, wrong: true } : c))
        setTimeout(() => setQuizCards(prev => prev.map(c => c.num === cardNum ? { ...c, wrong: false } : c)), 400)
        setQuizFeedback('이 칸은 다른 숫자 자리예요')
        setQuizFeedbackColor('#F07070')
        speak('다시 해봐요.', ttsEnabledRef.current)
        setQuizChips(prev => prev.map((c, i) => i === chipIdx ? { ...c, isDragging: false } : c))
      }
    } else {
      setQuizChips(prev => prev.map((c, i) => i === chipIdx ? { ...c, isDragging: false } : c))
    }

    if (floatingRef.current) { floatingRef.current.remove(); floatingRef.current = null }
    isDraggingRef.current = false
    dragValueRef.current = null
    dragChipIndexRef.current = null
  }, [clearDragHighlights, getQuizCardAt, addWrongNote, removeWrongNote, speak])

  // ── Quiz round functions ────────────────────────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nextQuizRound = useCallback(() => {
    setShowQuizNextBtn(false)
    quizRoundRef.current++
    quizPlacedInRoundRef.current = 0
    quizFirstTryRef.current = true

    const round = quizRoundRef.current
    const range = quizRangeRef.current
    const total = quizTotalRoundsRef.current

    setQuizLabel(`문제 ${round} / ${total}`)
    setQuizProgressPct(Math.round(((round - 1) / total) * 100))
    setQuizCorrect(quizCorrectRef.current)
    setQuizFeedback('')
    setQuizHintText('숨은 숫자를 찾아서 빈칸에 놓아봐요')
    setQuizHintColor('#6BADE8')

    const cardCount = range <= 5 ? 5 : 8
    const hideCount = range <= 5 ? 2 : 4
    const maxStart = range - cardCount + 1
    const start = Math.floor(Math.random() * maxStart) + 1
    const nums: number[] = []
    for (let i = start; i < start + cardCount; i++) nums.push(i)

    const indices = shuffleArr(Array.from({ length: cardCount }, (_, i) => i))
    const hiddenIndices = new Set(indices.slice(0, hideCount))
    const hiddenOrder: number[] = []
    const cards: QuizCardData[] = nums.map((n, i) => {
      const hidden = hiddenIndices.has(i)
      if (hidden) hiddenOrder.push(n)
      return { num: n, hidden, filled: false, wrong: false }
    })
    quizHiddenOrderRef.current = hiddenOrder

    const chipNums = shuffleArr([...hiddenOrder])
    setQuizCards(cards)
    setQuizChips(chipNums.map(n => ({ num: n, placed: false, isDragging: false })))
    setQuizCardLayout(cardCount >= 8 ? 8 : 5)
    quizCardElemsRef.current.clear()

    clearImpulse()
    applyImpulse(impulsePrevention, impulseMode, impulseDelay)
  }, [clearImpulse, applyImpulse, impulsePrevention, impulseMode, impulseDelay])

  const nextWNRound = useCallback(() => {
    setShowQuizNextBtn(false)
    if (wnRoundIdxRef.current >= wnChunksRef.current.length) {
      const sec = Math.floor((Date.now() - quizStartTimeRef.current) / 1000)
      setResultEmoji(quizWrongRef.current === 0 ? '🏆' : '👏')
      setResultMsg('완료!')
      setResultSub(`오답 연습 · ${sec}초 · 틀린 횟수 ${quizWrongRef.current}번`)
      lastGameCompletedRef.current = true
      isWnPracticeRef.current = false
      setView('result')
      return
    }

    quizRoundRef.current++
    quizPlacedInRoundRef.current = 0
    quizFirstTryRef.current = true

    const hiddenInRound = wnChunksRef.current[wnRoundIdxRef.current]
    wnRoundIdxRef.current++
    const totalChunks = wnChunksRef.current.length

    setQuizLabel(`오답 연습 ${quizRoundRef.current} / ${totalChunks}`)
    setQuizProgressPct(Math.round(((quizRoundRef.current - 1) / totalChunks) * 100))
    setQuizCorrect(quizCorrectRef.current)
    setQuizFeedback('')
    setQuizHintText('틀렸던 숫자를 다시 찾아봐요')
    setQuizHintColor('#F07070')

    const hnMin = hiddenInRound[0]
    const hnMax = hiddenInRound[hiddenInRound.length - 1]
    const cardCount = Math.min(8, Math.max(hiddenInRound.length + 2, 5))
    const neededVisible = cardCount - hiddenInRound.length
    let sStart = Math.max(1, hnMin - Math.floor(neededVisible / 2))
    let sEnd = sStart + cardCount - 1
    if (sEnd > 100) { sEnd = 100; sStart = Math.max(1, sEnd - cardCount + 1) }
    if (hnMax > sEnd) { sEnd = hnMax; sStart = Math.max(1, sEnd - cardCount + 1) }
    if (hnMin < sStart) { sStart = hnMin; sEnd = sStart + cardCount - 1 }

    const hiddenSet = new Set(hiddenInRound)
    const quizNums: number[] = []
    for (let i = sStart; i <= sEnd; i++) quizNums.push(i)
    const hiddenOrder = quizNums.filter(n => hiddenSet.has(n))
    quizHiddenOrderRef.current = hiddenOrder

    const cards: QuizCardData[] = quizNums.map(n => ({
      num: n, hidden: hiddenSet.has(n), filled: false, wrong: false
    }))
    const chipNums = shuffleArr([...hiddenInRound])
    setQuizCards(cards)
    setQuizChips(chipNums.map(n => ({ num: n, placed: false, isDragging: false })))
    setQuizCardLayout(quizNums.length >= 8 ? 8 : 5)
    quizCardElemsRef.current.clear()

    clearImpulse()
    applyImpulse(impulsePrevention, impulseMode, impulseDelay)
  }, [clearImpulse, applyImpulse, impulsePrevention, impulseMode, impulseDelay])

  const startQuiz = useCallback((range: number) => {
    if (!localStorage.getItem('slowmath_number_login')) {
      sessionStorage.setItem('_sp', JSON.stringify(['quiz', range]))
      setView('login')
      return
    }

    lastGameCompletedRef.current = false
    quizRangeRef.current = range
    quizRoundRef.current = 0
    quizCorrectRef.current = 0
    quizWrongRef.current = 0
    quizStartTimeRef.current = Date.now()
    quizTotalRoundsRef.current = QUIZ_TOTAL
    isWnPracticeRef.current = false
    setQuizTotalRounds(QUIZ_TOTAL)
    setQuizCorrect(0)
    setView('quiz')

    if (typeof window !== 'undefined' && window.speechSynthesis)
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(''))

    // nextQuizRound called after view transitions
    setTimeout(() => nextQuizRound(), 50)
  }, [nextQuizRound])

  // ── Global drag event listeners ─────────────────────────────
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !floatingRef.current) return
      floatingRef.current.style.left = e.clientX + 'px'
      floatingRef.current.style.top = e.clientY + 'px'
      clearDragHighlights()
      if (isDragQuizRef.current) {
        const cardNum = getQuizCardAt(e.clientX, e.clientY)
        if (cardNum !== null) {
          const el = quizCardElemsRef.current.get(cardNum)
          if (el) el.classList.add('drag-over')
        }
      } else {
        const target = getSlotAt(e.clientX, e.clientY)
        if (target) {
          const el = slotElemsRef.current.get(target.num)
          if (el && !el.classList.contains('filled')) el.classList.add('drag-over')
        }
      }
    }
    const onMouseUp = (e: MouseEvent) => {
      if (!isDraggingRef.current) return
      if (isDragQuizRef.current) endQuizDrag(e.clientX, e.clientY)
      else endGameDrag(e.clientX, e.clientY)
    }
    const onTouchMove = (e: TouchEvent) => {
      if (!isDraggingRef.current) return
      e.preventDefault()
      const t = e.touches[0]
      if (!floatingRef.current) return
      floatingRef.current.style.left = t.clientX + 'px'
      floatingRef.current.style.top = t.clientY + 'px'
      clearDragHighlights()
      if (isDragQuizRef.current) {
        const cardNum = getQuizCardAt(t.clientX, t.clientY)
        if (cardNum !== null) {
          const el = quizCardElemsRef.current.get(cardNum)
          if (el) el.classList.add('drag-over')
        }
      } else {
        const target = getSlotAt(t.clientX, t.clientY)
        if (target) {
          const el = slotElemsRef.current.get(target.num)
          if (el && !el.classList.contains('filled')) el.classList.add('drag-over')
        }
      }
    }
    const onTouchEnd = (e: TouchEvent) => {
      if (!isDraggingRef.current) return
      const t = e.changedTouches[0]
      if (isDragQuizRef.current) endQuizDrag(t.clientX, t.clientY)
      else endGameDrag(t.clientX, t.clientY)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('touchmove', onTouchMove, { passive: false })
    document.addEventListener('touchend', onTouchEnd)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('touchend', onTouchEnd)
    }
  }, [clearDragHighlights, endGameDrag, endQuizDrag, getSlotAt, getQuizCardAt])

  // ── Navigation ──────────────────────────────────────────────
  const goHome = useCallback(() => {
    clearImpulse()
    if (floatingRef.current) { floatingRef.current.remove(); floatingRef.current = null }
    isDraggingRef.current = false
    isWnPracticeRef.current = false
    setView('start')
    const completed = lastGameCompletedRef.current
    lastGameCompletedRef.current = false
    if (completed) {
      setTimeout(() => {
        const item = SM_RECO[Math.floor(Math.random() * SM_RECO.length)]
        setRecoItem(item)
        setRecoVisible(true)
      }, 350)
    }
  }, [clearImpulse])

  const replay = useCallback(() => {
    const mode = gameModeRef.current
    if (mode === 'game') startGame(lastRange, lastStart)
    else if (mode === 'quiz') startQuiz(lastRange)
    else if (mode === 'fill') startFillGame(lastRange, lastStart)
    else goHome()
  }, [startGame, startQuiz, startFillGame, goHome, lastRange, lastStart])

  // ── Login / Logout ──────────────────────────────────────────
  const socialLogin = useCallback((provider: string) => {
    localStorage.setItem('slowmath_number_login', JSON.stringify({ provider, loginTime: new Date().toISOString() }))
    document.body.classList.add('sm-loggedin')
    setIsLoggedIn(true)
    const sp = sessionStorage.getItem('_sp')
    if (sp) {
      sessionStorage.removeItem('_sp')
      const args = JSON.parse(sp)
      if (args[0] === 'fill') startFillGame(args[1], args[2])
      else if (args[0] === 'quiz') startQuiz(args[1])
      else startGame(args[0], args[1])
      return
    }
    setView('start')
  }, [startGame, startFillGame, startQuiz])

  const socialLogout = useCallback(() => {
    localStorage.removeItem('slowmath_number_login')
    document.body.classList.remove('sm-loggedin')
    setIsLoggedIn(false)
    setView('start')
  }, [])

  // ── Share app ────────────────────────────────────────────────
  const shareApp = useCallback(() => {
    const SHARE_KEY = 'slowmath_share_days'
    const days = parseInt(localStorage.getItem(SHARE_KEY) || '0')
    function onShared() {
      const newDays = Math.min(days + 1, 5)
      localStorage.setItem(SHARE_KEY, String(newDays))
      if (shareToastTimerRef.current) clearTimeout(shareToastTimerRef.current)
      setShareToast('하루 무료 이용권이 지급되었습니다!')
      setShareToastVisible(true)
      shareToastTimerRef.current = setTimeout(() => setShareToastVisible(false), 3000)
    }
    if (typeof navigator !== 'undefined' && navigator.share) {
      navigator.share({ title: document.title, url: location.href }).then(onShared).catch(() => {})
    } else {
      if (navigator.clipboard) navigator.clipboard.writeText(location.href)
      alert('링크가 복사되었어요!')
      onShared()
    }
  }, [])

  // ── Wrong notes ─────────────────────────────────────────────
  const startWrongNotePractice = useCallback(() => {
    const notes = getWrongNotes()
    if (notes.length === 0) return
    const sorted = [...notes].sort((a, b) => a - b)
    const hideCount = Math.min(sorted.length <= 4 ? sorted.length : 4, sorted.length)
    const chunks: number[][] = []
    for (let i = 0; i < sorted.length; i += hideCount) chunks.push(sorted.slice(i, i + hideCount))

    quizRangeRef.current = sorted[sorted.length - 1]
    quizRoundRef.current = 0
    quizCorrectRef.current = 0
    quizWrongRef.current = 0
    quizStartTimeRef.current = Date.now()
    quizTotalRoundsRef.current = chunks.length
    isWnPracticeRef.current = true
    wnChunksRef.current = chunks
    wnRoundIdxRef.current = 0

    setQuizTotalRounds(chunks.length)
    setQuizCorrect(0)
    setView('quiz')
    setTimeout(() => nextWNRound(), 50)
  }, [getWrongNotes, nextWNRound])

  // ── Share bubble visibility based on share count ─────────────
  const shareDays = typeof window !== 'undefined' ? parseInt(localStorage.getItem('slowmath_share_days') || '0') : 0

  // ── Effects for login state on body ─────────────────────────
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.body.classList.toggle('sm-loggedin', isLoggedIn && shareDays < 5)
    }
  }, [isLoggedIn, shareDays])

  // ── Progress computation ─────────────────────────────────────
  const totalSlots = gameMode === 'fill' ? fillTotal : (maxNum - startNum + 1)
  const progressPct = totalSlots > 0 ? Math.round((placedCount / totalSlots) * 100) : 0

  // ── Render ──────────────────────────────────────────────────
  return (
    <>
      {/* Splash */}
      {showSplash && (
        <div className={`splash-overlay${splashFading ? ' fade-out' : ''}`}>
          <div className="splash-logo">
            <LogoSVG width={140} height={117} />
          </div>
          <h1 className="splash-title">
            <span style={{ color: '#6BADE8' }}>느린</span>
            <span style={{ color: '#F0A050' }}>아이</span>{' '}
            <span style={{ color: '#4A4035' }}>숫자 익히기</span>
          </h1>
          <p className="splash-subtitle">숫자를 순서대로 배워보세요</p>
        </div>
      )}

      <div className="app">

        {/* ── Login View ── */}
        {view === 'login' && (
          <div className="login-view">
            <div className="login-logo-area">
              <LogoSVG />
              <h1>
                <span style={{ color: '#6BADE8' }}>느린</span>
                <span style={{ color: '#F0A050' }}>아이</span>{' '}
                <span style={{ color: '#4A4035' }}>숫자 익히기</span>
              </h1>
              <p className="login-subtitle">숫자를 순서대로 배워보세요</p>
            </div>
            <p className="login-trial">가입하시고 하루 동안 모든 기능을<br />무료로 체험해보세요</p>
            <div className="login-buttons">
              <button className="login-btn kakao" onClick={() => socialLogin('kakao')}>
                <svg width="20" height="20" viewBox="0 0 20 20"><path d="M10 1C4.477 1 0 4.477 0 8.667c0 2.7 1.753 5.072 4.393 6.413-.192.717-.694 2.6-.794 3.004-.124.497.182.49.383.356.158-.105 2.51-1.708 3.525-2.398.8.118 1.628.18 2.493.18 5.523 0 10-3.477 10-7.555C20 4.477 15.523 1 10 1z" fill="#191919"/></svg>
                카카오로 시작하기
              </button>
              <button className="login-btn google" onClick={() => socialLogin('google')}>
                <svg width="20" height="20" viewBox="0 0 48 48"><path d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" fill="#FFC107"/><path d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" fill="#FF3D00"/><path d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0124 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" fill="#4CAF50"/><path d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 01-4.087 5.571l.001-.001 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" fill="#1976D2"/></svg>
                Google로 시작하기
              </button>
            </div>
          </div>
        )}

        {/* ── Start View ── */}
        {view === 'start' && (
          <div className="flex flex-col flex-1 relative">
            {/* Share button */}
            {isLoggedIn && shareDays < 5 && (
            <button onClick={shareApp} title="공유하기"
              style={{ position: 'absolute', top: 0, right: 0, background: 'white', border: '2px solid #E8E2DA', borderRadius: 10, width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#8C8070', zIndex: 10 }}>
              <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7M16 6l-4-4-4 4M12 2v13"/></svg>
            </button>
            )}
            {shareDays < 5 && isLoggedIn && (
              <div className="share-bubble" style={{ top: 44 }}>
                지금 지인에게 공유하시면<br />하루 무료 이용권을 드려요
              </div>
            )}

            {/* Header */}
            <div className="text-center pt-2 pb-3">
              <div className="inline-block mb-2">
                <LogoSVG width={90} height={75} />
              </div>
              <h1 className="font-black tracking-tight" style={{ fontSize: '1.6rem' }}>
                <span style={{ color: '#6BADE8' }}>느린</span>
                <span style={{ color: '#F0A050' }}>아이</span>{' '}
                <span style={{ color: '#4A4035' }}>숫자 익히기</span>
              </h1>
              <p className="brand-sub">숫자를 순서대로 배워보세요.</p>
            </div>

            <div style={{ height: 8 }} />

            <div className="flex flex-col gap-3 flex-1">
              {/* 숫자 순서 맞추기 */}
              <div className="game-section">
                <div className="game-section-header">
                  <div className="icon-order">
                    <div className="slot-box"><span className="num-fill">1</span></div>
                    <div className="slot-box"><span className="num-fill">2</span></div>
                    <div className="slot-box"><span className="num-fill">3</span></div>
                  </div>
                  <span className="game-section-title">숫자 순서 맞추기</span>
                  <span className="game-section-desc">끌어서 빈칸 채우기</span>
                </div>
                <div className="settings-group">
                  <div className="settings-row">
                    <span className="settings-label">읽기</span>
                    <div className="settings-options">
                      <button onClick={() => { setCountingMode('sino'); saveSettings({ ttsEnabled, impulsePrevention, impulseMode, impulseDelay, countingMode: 'sino', reverseMode, ghostMode }) }}
                        className={`counting-mode-btn${countingMode === 'sino' ? ' selected' : ''}`}>일, 이, 삼</button>
                      <button onClick={() => { setCountingMode('native'); saveSettings({ ttsEnabled, impulsePrevention, impulseMode, impulseDelay, countingMode: 'native', reverseMode, ghostMode }) }}
                        className={`counting-mode-btn${countingMode === 'native' ? ' selected' : ''}`}>하나, 둘, 셋</button>
                    </div>
                  </div>
                  <div className="settings-row">
                    <span className="settings-label">순서</span>
                    <div className="settings-options">
                      <button onClick={() => { setReverseMode(false); saveSettings({ ttsEnabled, impulsePrevention, impulseMode, impulseDelay, countingMode, reverseMode: false, ghostMode }) }}
                        className={`counting-mode-btn${!reverseMode ? ' selected' : ''}`}>1, 2, 3 정방향</button>
                      <button onClick={() => { setReverseMode(true); saveSettings({ ttsEnabled, impulsePrevention, impulseMode, impulseDelay, countingMode, reverseMode: true, ghostMode }) }}
                        className={`counting-mode-btn${reverseMode ? ' selected' : ''}`}>10, 9, 8 역방향</button>
                    </div>
                  </div>
                  <div className="settings-row">
                    <span className="settings-label">빈칸</span>
                    <div className="settings-options">
                      <button onClick={() => { setGhostMode(false); saveSettings({ ttsEnabled, impulsePrevention, impulseMode, impulseDelay, countingMode, reverseMode, ghostMode: false }) }}
                        className={`counting-mode-btn${!ghostMode ? ' selected' : ''}`}>힌트 숨김</button>
                      <button onClick={() => { setGhostMode(true); saveSettings({ ttsEnabled, impulsePrevention, impulseMode, impulseDelay, countingMode, reverseMode, ghostMode: true }) }}
                        className={`counting-mode-btn${ghostMode ? ' selected' : ''}`}>힌트 보임</button>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {([5, 10, 20, 30, 50] as const).map(r => (
                    <button key={r} onClick={() => startGame(r)} data-range={String(r)}
                      className="mode-card rounded-xl p-3 text-left border-2" style={{ borderColor: '#E8E2DA', background: 'white' }}>
                      <p className="font-bold" style={{ color: '#4A4035' }}>1 부터 {r}</p>
                      <p className="text-xs mt-0.5" style={{ color: '#B8AD9E' }}>{r === 5 ? '반 줄' : r === 10 ? '한 줄' : r === 20 ? '두 줄' : r === 30 ? '세 줄' : '다섯 줄'}</p>
                    </button>
                  ))}
                  <button onClick={() => startGame(100, 51)} data-range="100"
                    className="mode-card rounded-xl p-3 text-left border-2" style={{ borderColor: '#E8E2DA', background: 'white' }}>
                    <p className="font-bold" style={{ color: '#4A4035' }}>51 부터 100</p>
                    <p className="text-xs mt-0.5" style={{ color: '#B8AD9E' }}>다섯 줄</p>
                  </button>
                </div>
              </div>

              {/* 부분 빈칸 채우기 */}
              <div className="game-section">
                <div className="game-section-header">
                  <div className="icon-blank">
                    <div className="ib-card ib-fixed">1</div>
                    <div className="ib-card ib-empty"><span className="ib-q">?</span><span className="ib-ans">2</span></div>
                    <div className="ib-card ib-fixed">3</div>
                  </div>
                  <span className="game-section-title">부분 빈칸 채우기</span>
                  <span className="game-section-desc">숨은 숫자를 찾아요</span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { r: 5, sub: '5개 중\n2개 숨김' },
                    { r: 10, sub: '8개 중\n4개 숨김' },
                    { r: 20, sub: '8개 중\n4개 숨김' },
                    { r: 30, sub: '8개 중\n4개 숨김' },
                    { r: 50, sub: '8개 중\n4개 숨김' },
                    { r: 100, sub: '8개 중\n4개 숨김' },
                  ].map(({ r, sub }) => (
                    <button key={r} onClick={() => startQuiz(r)} data-range={String(r)}
                      className="mode-card rounded-xl p-3 text-left border-2" style={{ borderColor: '#E8E2DA', background: 'white' }}>
                      <p className="font-bold" style={{ color: '#4A4035' }}>1 부터 {r}</p>
                      <p className="text-xs mt-0.5" style={{ color: '#B8AD9E', whiteSpace: 'pre-line' }}>{sub}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* 전체 빈칸 채우기 */}
              <div className="game-section">
                <div className="game-section-header">
                  <div className="icon-fill">
                    <div className="fb fb-empty"><span className="fb-num">1</span></div>
                    <div className="fb fb-hint">2</div>
                    <div className="fb fb-empty"><span className="fb-num">3</span></div>
                    <div className="fb fb-empty"><span className="fb-num">4</span></div>
                    <div className="fb fb-hint">5</div>
                  </div>
                  <span className="game-section-title">전체 빈칸 채우기</span>
                  <span className="game-section-desc">힌트를 보고 나머지를 채워요</span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { r: 5, s: 1, sub: '2개 힌트' },
                    { r: 10, s: 1, sub: '3개 힌트' },
                    { r: 20, s: 1, sub: '6개 힌트' },
                    { r: 30, s: 1, sub: '9개 힌트' },
                    { r: 50, s: 1, sub: '15개 힌트' },
                    { r: 100, s: 51, sub: '15개 힌트' },
                  ].map(({ r, s, sub }) => (
                    <button key={r} onClick={() => startFillGame(r, s)} data-range={String(r)}
                      className="mode-card rounded-xl p-3 text-left border-2" style={{ borderColor: '#E8E2DA', background: 'white' }}>
                      <p className="font-bold" style={{ color: '#4A4035' }}>{s === 1 ? `1 부터 ${r}` : `${s} 부터 ${r}`}</p>
                      <p className="text-xs mt-0.5" style={{ color: '#B8AD9E' }}>{sub}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* 오답노트 버튼 */}
              {wrongNotes.length > 0 && (
                <button className="wrong-notes-btn" onClick={() => setView('wrongNotes')}>
                  오답노트 <span className="badge">{wrongNotes.length}</span>
                </button>
              )}

              <div style={{ marginTop: 'auto' }} />

              {/* 설정 영역 */}
              <div className="settings-section">
                <div className="setting-row">
                  <div>
                    <div className="setting-label">음성</div>
                    <div className="setting-desc">정답/오답 음성 안내</div>
                  </div>
                  <button onClick={() => {
                    const next = !ttsEnabled
                    setTtsEnabled(next)
                    if (!next && typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel()
                    saveSettings({ ttsEnabled: next, impulsePrevention, impulseMode, impulseDelay, countingMode, reverseMode, ghostMode })
                  }} className={`toggle-track${ttsEnabled ? ' on' : ''}`}>
                    <span className="toggle-knob" />
                  </button>
                </div>
                <div className="setting-row">
                  <div>
                    <div className="setting-label">충동방지</div>
                    <div className="setting-desc">생각할 시간을 줘요</div>
                  </div>
                  <button onClick={() => {
                    const next = !impulsePrevention
                    setImpulsePrevention(next)
                    saveSettings({ ttsEnabled, impulsePrevention: next, impulseMode, impulseDelay, countingMode, reverseMode, ghostMode })
                  }} className={`toggle-track${impulsePrevention ? ' on' : ''}`}>
                    <span className="toggle-knob" />
                  </button>
                </div>
                {impulsePrevention && (
                  <div className="impulse-details show" style={{ display: 'block' }}>
                    <div className="impulse-mode-options">
                      <button className={`impulse-mode-btn${impulseMode === 'hide' ? ' selected' : ''}`}
                        onClick={() => { setImpulseMode('hide'); saveSettings({ ttsEnabled, impulsePrevention, impulseMode: 'hide', impulseDelay, countingMode, reverseMode, ghostMode }) }}>
                        <span className="impulse-mode-icon">👀</span>
                        <span className="impulse-mode-label">보기 확인</span>
                        <span className="impulse-mode-desc">버튼을 누르면 보기가 나타나요</span>
                      </button>
                      <button className={`impulse-mode-btn${impulseMode === 'lock' ? ' selected' : ''}`}
                        onClick={() => { setImpulseMode('lock'); saveSettings({ ttsEnabled, impulsePrevention, impulseMode: 'lock', impulseDelay, countingMode, reverseMode, ghostMode }) }}>
                        <span className="impulse-mode-icon">🔒</span>
                        <span className="impulse-mode-label">선택 잠금</span>
                        <span className="impulse-mode-desc">N초 동안 선택할 수 없어요</span>
                      </button>
                    </div>
                    <div className="imp-sec-row">
                      {[1,2,3,4,5,6,7,8,9,10].map(n => (
                        <button key={n} onClick={() => { setImpulseDelay(n); saveSettings({ ttsEnabled, impulsePrevention, impulseMode, impulseDelay: n, countingMode, reverseMode, ghostMode }) }}
                          className={`imp-sec${impulseDelay === n ? ' active' : ''}`}>{n}초</button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div style={{ textAlign: 'center', marginTop: 24 }}>
              {isLoggedIn && (
                <button className="logout-btn" onClick={socialLogout}>로그아웃</button>
              )}
            </div>
          </div>
        )}

        {/* ── Game View (game + fill modes) ── */}
        {view === 'game' && (
          <div className="flex flex-col flex-1 fade-in">
            <div className="flex items-center gap-3 mb-4">
              <button onClick={goHome} className="btn-home" title="홈">
                <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M3 12l9-8 9 8M5 11v9a1 1 0 001 1h3m8 0h3a1 1 0 001-1v-9"/></svg>
              </button>
              <div className="flex-1">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-xs font-medium" style={{ color: '#B8AD9E' }}>{gameLabel}</span>
                  <span className="text-xs font-medium" style={{ color: '#B8AD9E' }}>{placedCount} / {totalSlots}</span>
                </div>
                <div className="progress-track">
                  <div className="progress-bar" style={{ width: `${progressPct}%` }} />
                </div>
              </div>
            </div>

            <p className="text-center text-sm mb-4 font-medium" style={{ color: hintColor }}>{hintText}</p>

            {/* Slots */}
            <div className="slots-grid mb-5"
              style={{ gridTemplateColumns: `repeat(${slots.length <= 5 ? 5 : 10}, 1fr)`, fontSize: maxNum >= 100 ? '0.7rem' : '' }}>
              {slots.map((s) => (
                <div key={s.num}
                  ref={el => { if (el) slotElemsRef.current.set(s.num, el); else slotElemsRef.current.delete(s.num) }}
                  className={`slot${s.filled ? ' filled' : ''}${s.wrong ? ' wrong' : ''}`}
                  style={s.hint ? { background: '#E8F5E9', color: '#388E3C', border: '2.5px solid #5BC886', fontSize: '1.25rem' } : {}}>
                  {s.filled ? s.num : (ghostMode && !s.hint ? <span className="ghost-num">{s.num}</span> : null)}
                </div>
              ))}
            </div>

            <div className="mb-2" style={{ borderTop: '1.5px solid #F0ECE6' }} />
            <p className="text-center text-xs mb-2 mt-2" style={{ color: '#D0C8BC' }}>아래 숫자를 위 빈칸으로 끌어다 놓으세요</p>

            {/* Impulse UI */}
            {chipsHidden && (
              <button className="reveal-btn" onClick={() => setChipsHidden(false)}>보기 확인</button>
            )}
            {impulseCountdown !== null && (
              <div className="delay-countdown">{impulseCountdown}초 동안 생각해 보세요</div>
            )}

            {/* Chips scatter area */}
            <div ref={chipContainerRef} className={`scatter-area${chipsHidden ? ' chips-hidden' : ''}${chipsLocked ? ' chips-locked' : ''}`}
              style={{ minHeight: scatterH }}>
              {chips.map((c, i) => (
                <div key={c.num}
                  className={`num-chip${c.isDragging ? ' dragging' : ''}${c.placed ? ' placed' : ''}`}
                  style={{
                    left: c.x, top: c.y,
                    width: chipPx, height: chipPx,
                    fontSize: `${((chipPx * 0.35) / 16).toFixed(2)}rem`,
                  }}
                  onMouseDown={e => { e.preventDefault(); beginDrag(i, c.num, e.clientX, e.clientY, false) }}
                  onTouchStart={e => { e.preventDefault(); beginDrag(i, c.num, e.touches[0].clientX, e.touches[0].clientY, false) }}
                >
                  {c.num}
                </div>
              ))}
            </div>

            <div className="text-center h-8 text-base font-bold mt-4" style={{ color: feedbackColor }}>{feedback}</div>
          </div>
        )}

        {/* ── Quiz View ── */}
        {view === 'quiz' && (
          <div className="flex flex-col flex-1 fade-in">
            <div className="flex items-center gap-3 mb-4">
              <button onClick={goHome} className="btn-home" title="홈">
                <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M3 12l9-8 9 8M5 11v9a1 1 0 001 1h3m8 0h3a1 1 0 001-1v-9"/></svg>
              </button>
              <div className="flex-1">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-xs font-medium" style={{ color: '#B8AD9E' }}>{quizLabel}</span>
                  <span className="text-xs font-medium" style={{ color: '#B8AD9E' }}>맞힌 문제: <span style={{ color: '#5BC886' }}>{quizCorrect}</span></span>
                </div>
                <div className="progress-track">
                  <div className="progress-bar" style={{ width: `${quizProgressPct}%` }} />
                </div>
              </div>
            </div>

            <p className="text-center text-sm mb-5 font-medium" style={{ color: quizHintColor }}>{quizHintText}</p>

            {/* Quiz cards */}
            <div id="quiz-cards" className={quizCardLayout >= 8 ? 'quiz-cards-8' : ''} style={{ marginBottom: 32 }}>
              {quizCards.map((c) => (
                <div key={c.num}
                  ref={el => {
                    if (c.hidden && !c.filled) {
                      if (el) quizCardElemsRef.current.set(c.num, el)
                      else quizCardElemsRef.current.delete(c.num)
                    }
                  }}
                  className={`quiz-card${c.hidden ? ' hidden-card' : ' open'}${c.filled ? ' filled' : ''}${c.wrong ? ' wrong' : ''}`}>
                  {c.filled ? c.num : c.hidden ? '?' : c.num}
                </div>
              ))}
            </div>

            <div className="mb-4" style={{ borderTop: '1.5px solid #F0ECE6' }} />
            <p className="text-center text-xs mb-3" style={{ color: '#D0C8BC' }}>숨은 숫자를 끌어다 놓으세요</p>

            {/* Impulse UI */}
            {chipsHidden && (
              <button className="reveal-btn" onClick={() => setChipsHidden(false)}>보기 확인</button>
            )}
            {impulseCountdown !== null && (
              <div className="delay-countdown">{impulseCountdown}초 동안 생각해 보세요</div>
            )}

            <div id="quiz-chips" className={`flex justify-center gap-3 flex-wrap${chipsHidden ? ' chips-hidden' : ''}${chipsLocked ? ' chips-locked' : ''}`}>
              {quizChips.map((c, i) => (
                <div key={c.num}
                  className={`quiz-chip${c.isDragging ? ' dragging' : ''}${c.placed ? ' placed' : ''}`}
                  onMouseDown={e => { e.preventDefault(); beginDrag(i, c.num, e.clientX, e.clientY, true) }}
                  onTouchStart={e => { e.preventDefault(); beginDrag(i, c.num, e.touches[0].clientX, e.touches[0].clientY, true) }}>
                  {c.num}
                </div>
              ))}
            </div>

            <div className="text-center h-8 text-base font-bold mt-6" style={{ color: quizFeedbackColor }}>{quizFeedback}</div>
            {showQuizNextBtn && (
              <button className="btn-next-q" onClick={() => {
                setShowQuizNextBtn(false)
                if (quizNextFnRef.current) { const fn = quizNextFnRef.current; quizNextFnRef.current = null; fn() }
              }}>다음 문제 →</button>
            )}
          </div>
        )}

        {/* ── Wrong Notes View ── */}
        {view === 'wrongNotes' && (
          <div className="wn-view active flex-1">
            <div className="wn-header">
              <h2>오답노트</h2>
              <p>자주 틀리는 숫자를 다시 연습해요</p>
            </div>
            <div className="wn-list">
              {wrongNotes.length === 0
                ? <div className="wn-empty">틀린 숫자가 없어요!</div>
                : [...wrongNotes].sort((a, b) => a - b).map(n => (
                  <span key={n} className="wn-chip">{n}</span>
                ))
              }
            </div>
            <div className="wn-actions">
              <button className="wn-btn-back" onClick={() => setView('start')}>돌아가기</button>
              {wrongNotes.length > 0 && (
                <button className="wn-btn-start" onClick={startWrongNotePractice}>연습 시작</button>
              )}
            </div>
            {wrongNotes.length > 0 && (
              <button className="wn-btn-clear" onClick={() => {
                if (confirm('오답노트를 전체 삭제할까요?')) {
                  saveWrongNotes([])
                  setView('start')
                }
              }}>전체 삭제</button>
            )}
          </div>
        )}

        {/* ── Result View ── */}
        {view === 'result' && (
          <div className="flex flex-col flex-1 fade-in">
            <div className="complete-overlay">
              <div className="complete-emoji">{resultEmoji}</div>
              <div className="complete-msg">{resultMsg}</div>
              <div className="complete-sub">{resultSub}</div>
              <button className="next-btn" onClick={replay}>다시 하기</button>
              <button className="next-btn" onClick={goHome} style={{ background: '#EDE8E0', color: '#8C8070' }}>홈으로</button>
            </div>
          </div>
        )}
      </div>

      {/* Share toast */}
      <div style={{
        display: 'block', position: 'fixed', bottom: 32, left: '50%', transform: 'translateX(-50%)',
        background: '#3A7D44', color: 'white', padding: '12px 20px', borderRadius: 14,
        fontSize: '0.85rem', fontWeight: 600, zIndex: 9999,
        boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
        transition: 'opacity 0.4s',
        opacity: shareToastVisible ? 1 : 0,
        pointerEvents: 'none', whiteSpace: 'nowrap',
      }}>{shareToast}</div>

      {/* App Reco Popup */}
      {recoVisible && (
        <div style={{
          display: 'flex', position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.52)', zIndex: 500,
          alignItems: 'center', justifyContent: 'center', padding: 20, boxSizing: 'border-box',
        }}>
          <div style={{
            background: '#FFFDF8', borderRadius: 24, padding: '28px 22px 22px',
            maxWidth: 270, width: '100%', textAlign: 'center',
            boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
            animation: '_smPop .32s cubic-bezier(.34,1.56,.64,1) both',
          }}>
            <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#C4AA82', letterSpacing: '.08em', marginBottom: 14 }}>
              도움이 될만한 앱을 소개드려요!
            </div>
            <div style={{ fontSize: '2.75rem', marginBottom: 10, lineHeight: 1 }}>{recoItem.emoji}</div>
            <div style={{ fontSize: '1.15rem', fontWeight: 900, color: '#4A4035', marginBottom: 8 }}>{recoItem.title}</div>
            <div style={{ fontSize: '0.84rem', color: '#7B6545', lineHeight: 1.65, marginBottom: 20 }}>{recoItem.desc}</div>
            <a href={recoItem.url} target="_blank" rel="noopener noreferrer"
              style={{ display: 'block', background: '#6BADE8', color: '#fff', borderRadius: 14, padding: '15px 0', fontSize: '0.975rem', fontWeight: 700, textDecoration: 'none', marginBottom: 10, boxShadow: '0 4px 12px rgba(107,173,232,.3)' }}>
              바로 해보기 →
            </a>
            <button onClick={() => setRecoVisible(false)}
              style={{ background: 'none', border: 'none', color: '#C4AA82', fontSize: '0.84rem', cursor: 'pointer', fontFamily: 'inherit', padding: 6 }}>
              다음에 할게요
            </button>
          </div>
        </div>
      )}
    </>
  )
}
