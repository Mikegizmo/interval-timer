// Interval Timer PWA
// Vanilla JS, lightweight, mobile-first. Includes: wheel pickers, state machine,
// SVG ring progress, audio beeps, speech, vibration, wake lock, presets, offline SW.

const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => Array.from(root.querySelectorAll(s));

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

// ---------- Settings & Persistence ----------
const STORAGE_KEY = 'intervalTimer:lastSettings';
const PRESETS_KEY = 'intervalTimer:presets';

function loadSettings(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return null;
    return JSON.parse(raw);
  }catch{ return null; }
}
function saveSettings(settings){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function loadPresets(){
  try{
    const raw = localStorage.getItem(PRESETS_KEY);
    return raw ? JSON.parse(raw) : [];
  }catch{ return []; }
}
function savePresets(presets){
  localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
}
function uid(){ return Math.random().toString(36).slice(2,9); }

// ---------- Number Wheel Component ----------
class NumberWheel{
  constructor(el, {min=0, max=60, step=1, value=0}){
    this.el = el;
    this.min = min; this.max = max; this.step = step;
    this.value = clamp(value, min, max);
    this.onChange = () => {};
    this._build();
    this._bind();
    this.setValue(this.value, false);
  }
  _build(){
    this.el.classList.add('wheel');
    // Build items
    const frag = document.createDocumentFragment();
    // padding to allow center alignment for first/last items
    const pad = document.createElement('div'); pad.className='wheel-item'; pad.style.visibility='hidden';
    frag.appendChild(pad.cloneNode());
    for(let n=this.min; n<=this.max; n+=this.step){
      const div = document.createElement('div');
      div.className = 'wheel-item';
      div.setAttribute('role', 'option');
      div.textContent = String(n);
      div.dataset.value = String(n);
      frag.appendChild(div);
    }
    frag.appendChild(pad.cloneNode());
    this.el.innerHTML = '';
    this.el.appendChild(frag);
  }
  _bind(){
    let ticking = null;
    const itemH = 44; // match CSS
    const snap = () => {
      const center = this.el.scrollTop + (this.el.clientHeight/2);
      // index in list ignoring first padding
      const idx = Math.round((center - itemH) / itemH);
      const value = clamp(this.min + idx*this.step, this.min, this.max);
      const targetTop = ( ( (value - this.min)/this.step ) * itemH );
      this.el.scrollTo({ top: targetTop, behavior:'smooth' });
      this.setValue(value, true);
    };
    this.el.addEventListener('scroll', () => {
      if(ticking) cancelAnimationFrame(ticking);
      ticking = requestAnimationFrame(() => {
        const center = this.el.scrollTop + (this.el.clientHeight/2);
        const idx = Math.round((center - 44) / 44);
        const value = clamp(this.min + idx*this.step, this.min, this.max);
        this._highlight(value);
        this.el.setAttribute('aria-valuenow', String(value));
      });
    }, {passive:true});
    this.el.addEventListener('wheel', ()=>{}, {passive:true});
    this.el.addEventListener('touchend', snap);
    this.el.addEventListener('mouseup', snap);
    this.el.addEventListener('keydown', (e)=>{
      let delta = 0;
      if(e.key === 'ArrowUp') delta = -this.step;
      if(e.key === 'ArrowDown') delta = this.step;
      if(e.key === 'PageUp') delta = -this.step*5;
      if(e.key === 'PageDown') delta = this.step*5;
      if(delta){
        e.preventDefault();
        this.setValue(clamp(this.value+delta, this.min, this.max), true);
        const y = ((this.value - this.min)/this.step)*44;
        this.el.scrollTo({top:y, behavior:'smooth'});
      }
    });
    // Click to select
    this.el.addEventListener('click', (e)=>{
      const item = e.target.closest('.wheel-item');
      if(!item || !item.dataset.value) return;
      const v = Number(item.dataset.value);
      const y = ((v - this.min)/this.step)*44;
      this.el.scrollTo({top:y, behavior:'smooth'});
      this.setValue(v, true);
    });
  }
  _highlight(value){
    this.value = value;
    $$('.wheel-item', this.el).forEach(div => {
      div.classList.toggle('selected', Number(div.dataset.value) === value);
    });
  }
  setValue(v, fire){
    v = clamp(v, this.min, this.max);
    this._highlight(v);
    this.value = v;
    this.el.setAttribute('aria-valuenow', String(v));
    if(fire) this.onChange(v);
  }
  getValue(){ return this.value; }
}

// ---------- Audio & Speech ----------
class AudioEngine{
  constructor(){
    this.ctx = null;
    this.gain = null;
    this.enabled = true;
    this.volume = 0.7;
  }
  ensure(){
    if(this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.volume;
    this.gain.connect(this.ctx.destination);
  }
  setVolume(v){ this.volume = v; if(this.gain) this.gain.gain.value = v; }
  async beep(freq=880, duration=0.15){
    if(!this.enabled) return;
    this.ensure();
    const osc = this.ctx.createOscillator();
    osc.type='sine';
    osc.frequency.value = freq;
    osc.connect(this.gain);
    osc.start();
    await new Promise(r=>setTimeout(r, duration*1000));
    osc.stop();
  }
  async countIn(){ // 3-2-1 beeps
    await this.beep(600,0.1); await new Promise(r=>setTimeout(r,150));
    await this.beep(700,0.1); await new Promise(r=>setTimeout(r,150));
    await this.beep(800,0.2);
  }
}

function speak(text){
  if(!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.0; u.pitch = 1.0; u.volume = 1.0;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// ---------- Wake Lock ----------
let wakeLock = null;
async function requestWakeLock(enabled){
  if(!('wakeLock' in navigator)) return;
  if(enabled){
    try{
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', ()=>{
        console.log('Wake lock released');
      });
    }catch(e){ console.warn('WakeLock failed', e); }
  }else{
    if(wakeLock) { wakeLock.release(); wakeLock = null; }
  }
}
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState === 'visible' && $('#wakeToggle')?.checked){
    requestWakeLock(true);
  }
});

// ---------- Notifications ----------
async function ensureNotificationsPermission(){
  if(!('Notification' in window)) return false;
  if(Notification.permission === 'granted') return true;
  if(Notification.permission === 'denied') return false;
  const res = await Notification.requestPermission();
  return res === 'granted';
}

// ---------- Utility ----------
function fmt(sec){
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec/60);
  const s = sec % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ---------- App State ----------
const state = {
  settings: {
    exerciseSec: 30,
    restSec: 15,
    exercisesPerInterval: 6,
    intervals: 3,
    soundOn: true,
    vibrateOn: true,
    voiceOn: true,
    keepAwake: true,
    volume: 0.7
  },
  session: null, // active session object or null
};

// ---------- Build Wheels ----------
let wheels = {};
function buildWheels(){
  wheels.exercise = new NumberWheel($('#exerciseWheel'), {min:0, max:120, step:1, value:state.settings.exerciseSec});
  wheels.rest = new NumberWheel($('#restWheel'), {min:0, max:120, step:1, value:state.settings.restSec});
  wheels.exPerInt = new NumberWheel($('#exPerIntWheel'), {min:0, max:12, step:1, value:state.settings.exercisesPerInterval});
  wheels.intervals = new NumberWheel($('#intervalsWheel'), {min:0, max:12, step:1, value:state.settings.intervals});

  for(const [key, wheel] of Object.entries(wheels)){
    wheel.onChange = (v)=>{
      const map = {exercise:'exerciseSec', rest:'restSec', exPerInt:'exercisesPerInterval', intervals:'intervals'};
      state.settings[map[key]] = v;
      saveSettings(state.settings);
      updateTotalPreview();
    };
  }
}

// ---------- Total Preview ----------
function computeTotalSeconds({exerciseSec:A, restSec:R, exercisesPerInterval:E, intervals:I}){
  if(E<=0 || I<=0 || A<=0) return 0;
  const perInterval = (E*A) + Math.max(0, (E-1))*R; // no rest after last exercise
  return I * perInterval;
}
function updateTotalPreview(){
  const total = computeTotalSeconds(state.settings);
  // show under Start button as tooltip-ish
  $('#startBtn').title = total ? `Total workout time: ${fmt(total)}` : 'Total workout time: 00:00';
}

// ---------- Presets ----------
function refreshPresetsUI(){
  const select = $('#presetSelect');
  const presets = loadPresets();
  const current = select.value;
  select.innerHTML = '<option value="">— Presets —</option>' + presets.map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
  if(current) select.value = current;
}
function applySettings(s){
  state.settings = {...state.settings, ...s};
  wheels.exercise.setValue(state.settings.exerciseSec, false);
  wheels.rest.setValue(state.settings.restSec, false);
  wheels.exPerInt.setValue(state.settings.exercisesPerInterval, false);
  wheels.intervals.setValue(state.settings.intervals, false);
  $('#soundToggle').checked = state.settings.soundOn;
  $('#vibrateToggle').checked = state.settings.vibrateOn;
  $('#voiceToggle').checked = state.settings.voiceOn;
  $('#wakeToggle').checked = state.settings.keepAwake;
  $('#volume').value = String(state.settings.volume);
  updateTotalPreview();
  saveSettings(state.settings);
}

// ---------- Session Engine ----------
const audio = new AudioEngine();
let timerId = null;

function startSession(){
  // read toggles
  state.settings.soundOn = $('#soundToggle').checked;
  state.settings.vibrateOn = $('#vibrateToggle').checked;
  state.settings.voiceOn = $('#voiceToggle').checked;
  state.settings.keepAwake = $('#wakeToggle').checked;
  state.settings.volume = Number($('#volume').value);
  saveSettings(state.settings);

  audio.enabled = state.settings.soundOn;
  audio.setVolume(state.settings.volume);

  if(state.settings.keepAwake) requestWakeLock(true);

  const {exerciseSec, restSec, exercisesPerInterval, intervals} = state.settings;
  const now = Date.now();

  state.session = {
    currentInterval: 1,
    currentExercise: 1,
    phase: 'exercise',
    phaseEndsAt: now + exerciseSec*1000,
    paused: false,
    startedAt: now,
    elapsedActiveSec: 0,
    elapsedRestSec: 0
  };

  $('#setup').hidden = true;
  $('#workout').hidden = false;
  $('#summary').hidden = false; // keep hidden content structure valid, then hide content
  $('#summary').hidden = true;

  if(state.settings.voiceOn) speak('Exercise starts in 3, 2, 1');
  audio.countIn();

  updateUI();
  startTick();
  maybeAskNotifications();
}

function updateUI() {
  // Update timer display
  document.getElementById("current-timer").textContent = formatTime(totalTimeRemaining);

  // Update progress circle
  updateProgressRing(totalTimeRemaining, totalWorkoutTime);

  // Update interval/exercise counters
  document.getElementById("interval-counter").textContent = 
    `Interval ${currentInterval + 1} / ${totalIntervals}`;
  document.getElementById("exercise-counter").textContent = 
    `Exercise ${currentExercise + 1} / ${exercisesPerInterval}`;

  // If we're resting, change styling
  if (isRest) {
    document.getElementById("workout-screen").classList.add("resting");
  } else {
    document.getElementById("workout-screen").classList.remove("resting");
  }
}

function maybeAskNotifications(){
  // Ask once per load if we don't have permission
  if(('Notification' in window) && Notification.permission !== 'granted'){
    // Do not block; gentle ask after 1s
    setTimeout(async()=>{
      const ok = await ensureNotificationsPermission();
      if(ok && navigator.serviceWorker?.ready){
        (await navigator.serviceWorker.ready).showNotification('Interval Timer', { body: 'Notifications enabled' });
      }
    }, 1200);
  }
}

function startTick(){
  stopTick();
  timerId = setInterval(tick, 100); // 100ms for smooth ring
}
function stopTick(){
  if(timerId){ clearInterval(timerId); timerId = null; }
}

function vibrate(pattern=[200]){
  if(state.settings.vibrateOn && 'vibrate' in navigator){
    navigator.vibrate(pattern);
  }
}

function advancePhase(){
  const s = state.session;
  const set = state.settings;
  if(s.phase === 'exercise'){
    s.elapsedActiveSec += (set.exerciseSec);
    if(set.exercisesPerInterval === s.currentExercise){
      // last exercise in interval -> next interval or done
      if(s.currentInterval === set.intervals){
        endSession();
        return;
      } else {
        // auto go to next interval — but still include rest? spec says "go straight to the next interval".
        // We'll start the next interval's first exercise immediately.
        s.currentInterval += 1;
        s.currentExercise = 1;
        s.phase = 'exercise';
        s.phaseEndsAt = Date.now() + set.exerciseSec*1000;
        if(set.voiceOn) speak(`Interval ${s.currentInterval} begins. Exercise.`);
        audio.beep(900,0.15);
        vibrate([200, 60, 200]);
      }
    } else {
      // go to rest automatically
      s.phase = 'rest';
      s.phaseEndsAt = Date.now() + set.restSec*1000;
      if(set.voiceOn) speak('Rest');
      audio.beep(500,0.12);
      vibrate([120]);
    }
  } else if(s.phase === 'rest'){
    s.elapsedRestSec += (set.restSec);
    // next exercise
    s.phase = 'exercise';
    s.currentExercise += 1;
    s.phaseEndsAt = Date.now() + set.exerciseSec*1000;
    if(set.voiceOn) speak(`Exercise ${s.currentExercise}`);
    audio.beep(800,0.15);
    vibrate([200]);
  }
}

function endSession(){
  stopTick();
  requestWakeLock(false);
  const totalElapsed = Math.floor((Date.now() - state.session.startedAt)/1000);
  const s = state.session;
  const summary = {
    totalElapsed,
    active: s.elapsedActiveSec,
    rest: s.elapsedRestSec,
    intervals: state.settings.intervals,
    exercisesPerInterval: state.settings.exercisesPerInterval
  };
  showSummary(summary);
  state.session = null;
  if(navigator.serviceWorker?.ready && Notification.permission === 'granted'){
    navigator.serviceWorker.ready.then(reg=>{
      reg.showNotification('Workout complete', { body: 'Great job! Session finished.' });
    });
  }
}

function tick(){
  const s = state.session;
  if(!s) return;
  const now = Date.now();
  let msLeft = s.phaseEndsAt - now;
  if(msLeft <= 0){
    advancePhase();
    return;
  }

  // Update ring & times
  const mainTimeEl = $('#mainTime');
  mainTimeEl.textContent = fmt(Math.ceil(msLeft/1000));

  const totalRemainingEl = $('#totalRemaining');
  totalRemainingEl.textContent = 'Total left: ' + fmt(computeTotalRemaining());

  updateRing(msLeft);

  // Update counters/labels
  $('#phaseLabel').textContent = s.phase === 'exercise' ? 'Exercise' : 'Rest';
  $('#counters').textContent = `Exercise ${s.currentExercise}/${state.settings.exercisesPerInterval} • Interval ${s.currentInterval}/${state.settings.intervals}`;
}

function computeTotalRemaining(){
  const s = state.session;
  const set = state.settings;
  if(!s) return 0;
  const now = Date.now();
  let rem = Math.ceil((s.phaseEndsAt - now)/1000);
  // remaining exercises in current interval (after current phase resolves)
  let curEx = s.currentExercise;
  let curInt = s.currentInterval;

  if(s.phase === 'exercise'){
    // after this exercise: if more exercises, include rest+exercise pairs; else move to next interval
    let exLeftInInterval = set.exercisesPerInterval - curEx;
    if(exLeftInInterval > 0){
      rem += exLeftInInterval * (set.restSec + set.exerciseSec) - set.restSec; // no rest after last?
      // Actually: between remaining exercises there will be rest after each except the last -> (exLeftInInterval-1)*rest + exLeftInInterval*exercise
      rem += 0;
    }
  }else{ // rest phase
    // after rest -> next exercise
    let exLeftInInterval = set.exercisesPerInterval - curEx; // currentEx will increment after rest
    rem += (set.exerciseSec); // the upcoming exercise
    exLeftInInterval -= 0; // after increment, left will be (exLeftInInterval)
    if(exLeftInInterval > 0){
      rem += (exLeftInInterval) * (set.restSec + set.exerciseSec) - set.restSec;
    }
  }

  // remaining full intervals after current interval
  const intervalsLeft = set.intervals - curInt;
  if(intervalsLeft > 0){
    const perInt = (set.exercisesPerInterval*set.exerciseSec) + Math.max(0,(set.exercisesPerInterval-1))*set.restSec;
    rem += intervalsLeft * perInt;
  }
  return Math.max(0, rem);
}

// ---------- Ring ----------
const R = 54;
const CIRC = 2*Math.PI*R;
function updateRing(msLeft){
  const s = state.session;
  const set = state.settings;
  const total = (s.phase === 'exercise' ? set.exerciseSec : set.restSec) * 1000;
  const frac = clamp(1 - (msLeft/total), 0, 1);
  const dash = CIRC * (1 - frac);
  const ring = $('#ringProgress');
  ring.style.strokeDasharray = `${CIRC}`;
  ring.style.strokeDashoffset = `${dash}`;
  ring.style.stroke = (s.phase === 'exercise') ? 'var(--accent)' : 'var(--danger)';
}

// ---------- Controls ----------
function pauseResume(){
  const s = state.session;
  if(!s) return;
  if(!s.paused){
    s.paused = true;
    s.pauseStart = Date.now();
    stopTick();
    $('#pauseBtn').textContent = 'Resume';
    speak('Paused');
  }else{
    s.paused = false;
    const pausedDur = Date.now() - s.pauseStart;
    s.phaseEndsAt += pausedDur;
    startTick();
    $('#pauseBtn').textContent = 'Pause';
    speak('Resuming');
  }
}
function skipPhase(){
  if(!state.session) return;
  advancePhase();
}
function resetAll(){
  stopTick();
  requestWakeLock(false);
  $('#workout').hidden = true;
  $('#summary').hidden = true;
  $('#setup').hidden = false;
  updateTotalPreview();
}

// ---------- Summary ----------
function showSummary({totalElapsed, active, rest, intervals, exercisesPerInterval}){
  $('#workout').hidden = true;
  $('#summary').hidden = false;
  const el = $('#summaryContent');
  el.innerHTML = `
    <p><strong>Total elapsed:</strong> ${fmt(totalElapsed)}</p>
    <p><strong>Active time:</strong> ${fmt(active)} • <strong>Rest time:</strong> ${fmt(rest)}</p>
    <p><strong>Intervals:</strong> ${intervals} • <strong>Exercises per interval:</strong> ${exercisesPerInterval}</p>
  `;
}

// ---------- Event Bindings ----------
function bindUI(){
  $('#startBtn').addEventListener('click', startSession);
  $('#pauseBtn').addEventListener('click', pauseResume);
  $('#skipBtn').addEventListener('click', skipPhase);
  $('#resetBtn').addEventListener('click', resetAll);

  $('#muteBtn').addEventListener('click', ()=>{
    const slider = $('#volume');
    if(Number(slider.value) > 0){
      slider.dataset.prev = slider.value;
      slider.value = '0';
    }else{
      slider.value = slider.dataset.prev || '0.7';
    }
    state.settings.volume = Number(slider.value);
    audio.setVolume(state.settings.volume);
    saveSettings(state.settings);
  });

  $('#volume').addEventListener('input', (e)=>{
    const v = Number(e.target.value);
    state.settings.volume = v;
    audio.setVolume(v);
    saveSettings(state.settings);
  });

  $('#savePresetBtn').addEventListener('click', ()=>{
    const name = $('#presetName').value.trim();
    if(!name){ alert('Name your preset'); return; }
    const presets = loadPresets();
    presets.push({ id: uid(), name, settings: {...state.settings} });
    savePresets(presets);
    refreshPresetsUI();
    $('#presetName').value='';
  });
  $('#deletePresetBtn').addEventListener('click', ()=>{
    const id = $('#presetSelect').value;
    if(!id) return;
    const presets = loadPresets().filter(p=>p.id !== id);
    savePresets(presets);
    refreshPresetsUI();
  });
  $('#presetSelect').addEventListener('change', (e)=>{
    const id = e.target.value;
    if(!id) return;
    const p = loadPresets().find(x=>x.id===id);
    if(p) applySettings(p.settings);
  });

  // Back to setup from summary
  document.getElementById("backBtn").addEventListener("click", () => {
    // Stop any timers if still running
    clearInterval(timerId);
    timerInterval = null;

    // Reset state
    currentExercise = 0;
    currentInterval = 0;
    isRest = false;
    totalTimeRemaining = 0;

    // Hide summary and workout, show setup
    document.getElementById("summary-screen").classList.add("hidden");
    document.getElementById("workout-screen").classList.add("hidden");
    document.getElementById("setup-screen").classList.remove("hidden");

    // Restore saved settings to pickers
    loadLastSettings();
  });


  // PWA Install
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e)=>{
    e.preventDefault();
    deferredPrompt = e;
    $('#installBtn').hidden = false;
  });
  $('#installBtn').addEventListener('click', async()=>{
    if(!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    $('#installBtn').hidden = true;
    deferredPrompt = null;
  });
}

// ---------- Service Worker ----------
async function registerSW(){
  if('serviceWorker' in navigator){
    try{
      const reg = await navigator.serviceWorker.register('./service-worker.js');
      console.log('SW registered', reg.scope);
    }catch(e){ console.warn('SW failed', e); }
  }
}

// ---------- Init ----------
function init(){
  // Load settings
  const saved = loadSettings();
  if(saved) state.settings = {...state.settings, ...saved};

  buildWheels();
  bindUI();
  updateTotalPreview();
  applySettings(state.settings);
  registerSW();
}
window.addEventListener('load', init);
