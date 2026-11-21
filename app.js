/* Habitly — offline habit tracker PWA. Data is kept in localStorage on the device. */
(function () {
  'use strict';

  const STORE_KEY = 'habitly.v1';
  const TIMER_KEY = 'habitly.timer';
  const FIRED_KEY = 'habitly.fired';
  const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
  const EMOJIS = ['💧', '🏃', '🏋️', '📚', '🧘', '🥗', '😴', '✍️', '🚭', '💊', '🧹', '💻', '🙏', '🎸', '🌅', '🚶'];
  const COLORS = ['#5ee0a0', '#5ab8ff', '#b18cff', '#ff8fb1', '#ffb35c', '#ffe066', '#ff6b6b', '#4fd1c5'];
  const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const ICS_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const TODS = [
    { id: 'morning', label: '🌅 Morning' },
    { id: 'afternoon', label: '☀️ Afternoon' },
    { id: 'night', label: '🌙 Night' },
    { id: 'any', label: '⏳ Anytime' },
  ];
  const DURATIONS = [0, 5, 10, 15, 20, 30, 45, 60];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const $ = (sel) => document.querySelector(sel);
  const ui = { tab: 'all', weekOffset: 0, monthOffset: 0, editingId: null, detailId: null, installEvt: null };
  let state = load();
  let timer = readJSON(TIMER_KEY, null);
  let timerTick = null;
  let audioCtx = null;

  /* ---------- storage ---------- */
  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (err) {
      console.warn('Storage read failed', err);
      return fallback;
    }
  }
  function writeJSON(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.warn('Storage write failed, data kept for this session only', err);
    }
  }
  function migrate(h) {
    return {
      schedule: ALL_DAYS.slice(),
      tod: 'any',
      duration: 0,
      reminder: '',
      days: {},
      ...h,
    };
  }
  function load() {
    const data = readJSON(STORE_KEY, null);
    if (data && Array.isArray(data.habits)) return { v: 2, habits: data.habits.map(migrate) };
    return { v: 2, habits: [] };
  }
  function save() {
    writeJSON(STORE_KEY, state);
  }

  /* ---------- dates ---------- */
  function keyOf(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  function fromKey(key) {
    return new Date(`${key}T00:00:00`);
  }
  function today() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  function addDays(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  }
  function shortDate(d) {
    return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  }

  /* ---------- habit logic ---------- */
  const isDone = (h, key) => Boolean(h.days[key]);
  const isScheduled = (h, date) => h.schedule.includes(date.getDay());
  const byId = (id) => state.habits.find((h) => h.id === id);

  function firstDay(h) {
    const keys = Object.keys(h.days).filter((k) => h.days[k]);
    keys.push(h.created || keyOf(today()));
    keys.sort((a, b) => a.localeCompare(b));
    return fromKey(keys[0]);
  }

  // Streak counts consecutive scheduled days that were done. Off days never break it.
  function currentStreak(h) {
    let d = today();
    if (!isDone(h, keyOf(d))) d = addDays(d, -1);
    const start = firstDay(h);
    let count = 0;
    while (d >= start) {
      if (isDone(h, keyOf(d))) count += 1;
      else if (isScheduled(h, d)) break;
      d = addDays(d, -1);
    }
    return count;
  }

  function bestStreak(h) {
    const end = today();
    let best = 0;
    let run = 0;
    for (let d = firstDay(h); d <= end; d = addDays(d, 1)) {
      if (isDone(h, keyOf(d))) {
        run += 1;
        best = Math.max(best, run);
      } else if (isScheduled(h, d) && d < end) {
        run = 0;
      }
    }
    return best;
  }

  function rangeStats(h, from, to) {
    let planned = 0;
    let done = 0;
    for (let d = new Date(from); d <= to; d = addDays(d, 1)) {
      if (isScheduled(h, d)) planned += 1;
      if (isDone(h, keyOf(d))) done += 1;
    }
    return { planned, done };
  }

  function pct(done, planned) {
    if (!planned) return 0;
    return Math.min(100, Math.round((done / planned) * 100));
  }

  function totalDone(h) {
    return Object.values(h.days).filter(Boolean).length;
  }

  function scheduleText(h) {
    const s = h.schedule.slice().sort((a, b) => a - b).join(',');
    if (s === '0,1,2,3,4,5,6') return 'Every day';
    if (s === '1,2,3,4,5') return 'Weekdays';
    if (s === '0,6') return 'Weekends';
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return h.schedule.slice().sort((a, b) => a - b).map((i) => names[i]).join(', ');
  }

  function toggle(id, key) {
    const h = byId(id);
    if (!h) return;
    if (h.days[key]) delete h.days[key];
    else h.days[key] = 1;
    if (navigator.vibrate) navigator.vibrate(12);
    save();
    renderAll();
  }

  function markDone(id, key) {
    const h = byId(id);
    if (!h || h.days[key]) return;
    h.days[key] = 1;
    save();
    renderAll();
  }

  function uid() {
    if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
    const buf = new Uint32Array(2);
    crypto.getRandomValues(buf);
    return Date.now().toString(36) + buf[0].toString(36) + buf[1].toString(36);
  }

  /* ---------- DOM helper ---------- */
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style') node.style.cssText = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    });
    (children || []).forEach((c) => node.appendChild(c));
    return node;
  }

  function tile(num, label, percent) {
    const kids = [el('div', { class: 'num', text: String(num) }), el('div', { class: 'lbl', text: label })];
    if (percent !== undefined) kids.push(el('div', { class: 'progress' }, [el('i', { style: `width:${percent}%` })]));
    return el('div', { class: 'tile' }, kids);
  }

  /* ---------- home ---------- */
  function renderSummary() {
    const box = $('#summary');
    box.replaceChildren();
    const t = today();
    const due = state.habits.filter((h) => isScheduled(h, t) || isDone(h, keyOf(t)));
    box.classList.toggle('hidden', state.habits.length === 0);
    if (!state.habits.length) return;
    const doneToday = due.filter((h) => isDone(h, keyOf(t))).length;
    const topStreak = Math.max(0, ...state.habits.map(currentStreak));
    let planned = 0;
    let done = 0;
    state.habits.forEach((h) => {
      const r = rangeStats(h, addDays(t, -6), t);
      planned += r.planned;
      done += r.done;
    });
    box.append(
      tile(`${doneToday}/${due.length}`, 'Done today', pct(doneToday, due.length)),
      tile(`${topStreak}🔥`, 'Best current streak'),
      tile(`${pct(done, planned)}%`, 'Last 7 days', pct(done, planned))
    );
  }

  function renderTabs() {
    const tabs = [{ id: 'all', label: 'All' }].concat(TODS);
    $('#tabs').replaceChildren(
      ...tabs.map((t) =>
        el('button', {
          type: 'button',
          class: `tab${ui.tab === t.id ? ' sel' : ''}`,
          text: t.label,
          onclick: () => {
            ui.tab = t.id;
            renderHome();
          },
        })
      )
    );
  }

  function weekDates() {
    const end = addDays(today(), -7 * ui.weekOffset);
    return [6, 5, 4, 3, 2, 1, 0].map((i) => addDays(end, -i));
  }

  function renderWeekNav() {
    const dates = weekDates();
    const label = $('#week-label');
    label.textContent = ui.weekOffset === 0 ? 'Last 7 days' : `${shortDate(dates[0])} – ${shortDate(dates[6])}  ·  back to today`;
    label.classList.toggle('past', ui.weekOffset > 0);
    $('#week-next').disabled = ui.weekOffset === 0;
    $('#week-next').style.opacity = ui.weekOffset === 0 ? '0.3' : '1';
    const tKey = keyOf(today());
    $('#day-head').replaceChildren(
      ...dates.map((d) => el('span', { class: keyOf(d) === tKey ? 'is-today' : '', text: `${WEEKDAYS[d.getDay()]}\n${d.getDate()}` }))
    );
  }

  function habitMeta(h) {
    const streak = currentStreak(h);
    const plural = streak === 1 ? '' : 's';
    const parts = [streak ? `🔥 ${streak} day${plural}` : 'No streak yet'];
    if (h.duration) parts.push(`⏱ ${h.duration} min`);
    if (h.reminder) parts.push(`🔔 ${h.reminder}`);
    parts.push(scheduleText(h));
    return parts.join(' · ');
  }

  function dotButton(h, d) {
    const key = keyOf(d);
    const done = isDone(h, key);
    const cls = ['dot'];
    if (done) cls.push('done');
    if (!isScheduled(h, d)) cls.push('off');
    if (key === keyOf(today())) cls.push('today');
    return el('button', {
      class: cls.join(' '),
      type: 'button',
      text: '✓',
      'aria-label': `${h.name} ${key} ${done ? 'done' : 'not done'}`,
      'aria-pressed': String(done),
      onclick: () => toggle(h.id, key),
    });
  }

  function habitRow(h, dates) {
    const top = el('div', { class: 'habit-top' }, [
      el('button', { class: 'habit-info', type: 'button', onclick: () => openDetail(h.id) }, [
        el('span', { class: 'habit-name', text: `${h.emoji} ${h.name}` }),
        el('span', { class: 'habit-meta', text: habitMeta(h) }),
      ]),
    ]);
    if (h.duration) {
      top.appendChild(el('button', { class: 'play', type: 'button', text: '▶ Timer', 'aria-label': `Start ${h.name} timer`, onclick: () => openTimer(h.id) }));
    }
    const notToday = !isScheduled(h, today()) && ui.weekOffset === 0;
    const row = el('li', { class: `habit${notToday ? ' not-today' : ''}`, style: `--c:${h.color}` }, [top]);
    dates.forEach((d) => row.appendChild(dotButton(h, d)));
    return row;
  }

  function visibleHabits() {
    if (ui.tab === 'all') return state.habits;
    return state.habits.filter((h) => h.tod === ui.tab);
  }

  function renderHome() {
    const now = new Date();
    $('#today-label').textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
    renderTabs();
    renderSummary();
    renderWeekNav();
    const dates = weekDates();
    const list = visibleHabits();
    const box = $('#habit-groups');
    box.replaceChildren();
    TODS.forEach((tod) => {
      const items = list.filter((h) => h.tod === tod.id);
      if (!items.length) return;
      if (ui.tab === 'all') box.appendChild(el('h3', { class: 'group-title', text: tod.label }));
      box.appendChild(el('ul', { class: 'habits' }, items.map((h) => habitRow(h, dates))));
    });
    const noHabits = state.habits.length === 0;
    const empty = list.length === 0;
    $('#empty').classList.toggle('hidden', !empty);
    $('#empty-title').textContent = noHabits ? 'Start your first habit' : 'Nothing here yet';
    $('#empty-body').textContent = noHabits ? 'Small daily wins add up. Tap + to add one.' : 'No habits set for this time of day.';
    $('#week-nav').classList.toggle('hidden', empty);
    $('#day-head').classList.toggle('hidden', empty);
    $('#tabs').classList.toggle('hidden', noHabits);
  }

  /* ---------- sheets ---------- */
  function openSheet(id) {
    $(id).classList.remove('hidden');
  }
  function closeSheet(id) {
    $(id).classList.add('hidden');
  }

  function singleSelect(container, items, selected, render) {
    container.replaceChildren();
    items.forEach((item) => {
      const btn = render(item);
      btn.type = 'button';
      btn.dataset.value = String(item.id === undefined ? item : item.id);
      if (btn.dataset.value === String(selected)) btn.classList.add('sel');
      btn.addEventListener('click', () => {
        container.querySelectorAll('.sel').forEach((c) => c.classList.remove('sel'));
        btn.classList.add('sel');
        if (container.id === 'f-dur') $('#f-dur-custom').value = '';
      });
      container.appendChild(btn);
    });
  }
  function selectedValue(container, fallback) {
    const sel = container.querySelector('.sel');
    return sel ? sel.dataset.value : fallback;
  }

  function setDays(list) {
    $('#f-days').querySelectorAll('.day-chip').forEach((b) => {
      b.classList.toggle('sel', list.includes(Number(b.dataset.day)));
    });
  }
  function selectedDays() {
    return Array.from($('#f-days').querySelectorAll('.day-chip.sel')).map((b) => Number(b.dataset.day));
  }

  function openEditor(id) {
    ui.editingId = id || null;
    const h = id ? byId(id) : null;
    $('#edit-title').textContent = h ? 'Edit habit' : 'New habit';
    $('#f-name').value = h ? h.name : '';
    singleSelect($('#f-emoji'), EMOJIS, h ? h.emoji : EMOJIS[0], (e) => el('button', { class: 'chip', text: e, 'aria-label': e }));
    singleSelect($('#f-color'), COLORS, h ? h.color : COLORS[state.habits.length % COLORS.length], (c) => {
      const b = el('button', { class: 'chip color', 'aria-label': c });
      b.style.setProperty('--sw', c);
      return b;
    });
    $('#f-days').replaceChildren(
      ...WEEKDAYS.map((w, i) =>
        el('button', { type: 'button', class: 'day-chip', 'data-day': String(i), text: w, onclick: (e) => e.currentTarget.classList.toggle('sel') })
      )
    );
    setDays(h ? h.schedule : ALL_DAYS);
    singleSelect($('#f-tod'), TODS, h ? h.tod : defaultTod(), (t) =>
      el('button', {
        class: 'seg',
        text: t.label,
        onclick: () => {
          if (!$('#f-rem-on').checked) $('#f-rem-time').value = defaultTime(t.id);
        },
      })
    );
    const dur = h ? h.duration : 0;
    const preset = DURATIONS.includes(dur) ? dur : null;
    singleSelect($('#f-dur'), DURATIONS, preset, (m) => el('button', { class: 'seg', text: m ? `${m} min` : 'No timer' }));
    $('#f-dur-custom').value = preset === null ? String(dur) : '';
    $('#f-rem-on').checked = Boolean(h && h.reminder);
    $('#f-rem-time').value = (h && h.reminder) || defaultTime(h ? h.tod : defaultTod());
    openSheet('#edit-sheet');
  }

  function defaultTod() {
    return ui.tab === 'all' ? 'any' : ui.tab;
  }
  function defaultTime(tod) {
    return { morning: '07:00', afternoon: '13:00', night: '21:00' }[tod] || '09:00';
  }

  function readForm() {
    const custom = Number.parseInt($('#f-dur-custom').value, 10);
    const duration = Number.isFinite(custom) && custom > 0 ? Math.min(custom, 600) : Number(selectedValue($('#f-dur'), 0));
    return {
      name: $('#f-name').value.trim(),
      emoji: selectedValue($('#f-emoji'), EMOJIS[0]),
      color: selectedValue($('#f-color'), COLORS[0]),
      schedule: selectedDays(),
      tod: selectedValue($('#f-tod'), 'any'),
      duration,
      reminder: $('#f-rem-on').checked ? $('#f-rem-time').value : '',
    };
  }

  function submitEditor(evt) {
    evt.preventDefault();
    const data = readForm();
    if (!data.name) return;
    if (!data.schedule.length) {
      toast('Pick at least one day');
      return;
    }
    const existing = byId(ui.editingId);
    if (existing) Object.assign(existing, data);
    else state.habits.push(migrate({ id: uid(), created: keyOf(today()), ...data }));
    save();
    closeSheet('#edit-sheet');
    renderAll();
    toast(existing ? 'Habit updated' : 'Habit added');
    if (data.reminder) ensurePermission();
  }

  /* ---------- detail ---------- */
  function openDetail(id) {
    ui.detailId = id;
    ui.monthOffset = 0;
    renderDetail();
    openSheet('#detail-sheet');
  }

  function renderDetail() {
    const h = byId(ui.detailId);
    if (!h) return;
    $('#detail-sheet .sheet').style.setProperty('--c', h.color);
    $('#d-emoji').textContent = h.emoji;
    $('#d-name').textContent = h.name;
    const tod = TODS.find((t) => t.id === h.tod);
    const sub = [scheduleText(h), tod ? tod.label : ''];
    if (h.reminder) sub.push(`🔔 ${h.reminder}`);
    $('#d-sub').textContent = sub.join(' · ');
    const timerBtn = $('#d-timer');
    timerBtn.classList.toggle('hidden', !h.duration);
    timerBtn.textContent = `▶ Start ${h.duration} min timer`;

    const t = today();
    const life = rangeStats(h, firstDay(h), t);
    const m30 = rangeStats(h, addDays(t, -29), t);
    $('#d-stats').replaceChildren(
      tile(`${currentStreak(h)}🔥`, 'Current streak'),
      tile(bestStreak(h), 'Best streak'),
      tile(`${pct(m30.done, m30.planned)}%`, 'Last 30 days', pct(m30.done, m30.planned)),
      tile(`${pct(life.done, life.planned)}%`, 'All time', pct(life.done, life.planned)),
      tile(totalDone(h), 'Total check-ins'),
      tile(shortDate(firstDay(h)), 'Started')
    );
    renderCalendar(h);
    renderMonthBars(h);
  }

  function renderCalendar(h) {
    const t = today();
    const first = new Date(t.getFullYear(), t.getMonth() - ui.monthOffset, 1);
    const daysIn = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const r = rangeStats(h, first, new Date(first.getFullYear(), first.getMonth(), daysIn));
    $('#m-title').textContent = `${first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })} · ${r.done} done`;
    $('#m-next').style.opacity = ui.monthOffset === 0 ? '0.3' : '1';
    $('#cal-head').replaceChildren(...WEEKDAYS.map((w) => el('span', { text: w })));
    const cells = [];
    for (let i = 0; i < first.getDay(); i += 1) cells.push(el('span', { class: 'blank' }));
    for (let day = 1; day <= daysIn; day += 1) {
      const d = new Date(first.getFullYear(), first.getMonth(), day);
      const key = keyOf(d);
      const cls = [];
      if (isDone(h, key)) cls.push('done');
      if (!isScheduled(h, d)) cls.push('off');
      if (d > t) cls.push('future');
      if (key === keyOf(t)) cls.push('is-today');
      cells.push(el('button', { type: 'button', class: cls.join(' '), text: String(day), 'aria-label': key, onclick: () => toggle(h.id, key) }));
    }
    $('#d-cal').replaceChildren(...cells);
  }

  function renderMonthBars(h) {
    const t = today();
    const start = firstDay(h);
    const bars = [];
    let cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    const last = new Date(t.getFullYear(), t.getMonth(), 1);
    if ((last.getFullYear() - cursor.getFullYear()) * 12 + last.getMonth() - cursor.getMonth() < 11) {
      cursor = new Date(t.getFullYear(), t.getMonth() - 11, 1);
    }
    while (cursor <= last) {
      const end = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
      const r = rangeStats(h, cursor, end < t ? end : t);
      const p = pct(r.done, r.planned);
      const label = cursor.getMonth() === 0 ? `'${String(cursor.getFullYear()).slice(2)}` : MONTHS[cursor.getMonth()][0];
      bars.push(el('div', { class: 'bar', title: `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}: ${p}%` }, [
        el('i', { style: `height:${p}%` }),
        el('small', { text: label }),
      ]));
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    }
    const box = $('#d-years');
    box.replaceChildren(...bars);
    box.scrollLeft = box.scrollWidth;
  }

  function askDelete() {
    const h = byId(ui.detailId);
    if (!h) return;
    $('#c-title').textContent = `Delete "${h.name}"?`;
    $('#c-body').textContent = 'All its history will be removed. This cannot be undone.';
    openSheet('#confirm-sheet');
  }
  function confirmDelete() {
    state.habits = state.habits.filter((h) => h.id !== ui.detailId);
    if (timer && timer.habitId === ui.detailId) setTimer(null);
    ui.detailId = null;
    save();
    closeSheet('#confirm-sheet');
    closeSheet('#detail-sheet');
    renderAll();
    toast('Habit deleted');
  }

  /* ---------- timer ---------- */
  function setTimer(value) {
    timer = value;
    writeJSON(TIMER_KEY, value);
  }
  function remainingMs() {
    if (!timer) return 0;
    if (timer.endAt) return Math.max(0, timer.endAt - Date.now());
    return timer.remaining;
  }
  function fmt(ms) {
    const s = Math.ceil(ms / 1000);
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function openTimer(id) {
    const h = byId(id);
    if (!h) return;
    if (!timer || timer.habitId !== id) {
      if (timer && timer.endAt) toast('Switched timer to this habit');
      setTimer({ habitId: id, total: h.duration * 60000, remaining: h.duration * 60000, endAt: null });
    }
    $('#timer-sheet .sheet').style.setProperty('--c', h.color);
    $('#t-name').textContent = `${h.emoji} ${h.name}`;
    openSheet('#timer-sheet');
    renderTimer();
    startTicking();
  }

  function renderTimer() {
    if (!timer) return;
    const left = remainingMs();
    const ring = $('#t-ring');
    const circ = 2 * Math.PI * 96;
    ring.style.strokeDasharray = String(circ);
    ring.style.strokeDashoffset = String(circ * (1 - left / timer.total));
    $('#t-time').textContent = fmt(left);
    $('#t-of').textContent = `of ${Math.round(timer.total / 60000)} min`;
    let label = 'Resume';
    if (timer.endAt) label = 'Pause';
    else if (left === timer.total) label = 'Start';
    $('#t-toggle').textContent = label;
  }

  function startTicking() {
    clearInterval(timerTick);
    timerTick = setInterval(checkTimer, 250);
  }

  function checkTimer() {
    if (!timer) {
      clearInterval(timerTick);
      return;
    }
    if (timer.endAt && Date.now() >= timer.endAt) {
      finishTimer();
      return;
    }
    if (!$('#timer-sheet').classList.contains('hidden')) renderTimer();
  }

  function finishTimer() {
    const h = byId(timer.habitId);
    setTimer(null);
    clearInterval(timerTick);
    if (h) markDone(h.id, keyOf(today()));
    chime();
    if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 500]);
    notify('Time is up! ✅', h ? `${h.name} is done for today.` : 'Timer finished');
    closeSheet('#timer-sheet');
    toast(h ? `${h.name} complete 🎉` : 'Timer finished');
  }

  function toggleTimer() {
    if (!timer) return;
    primeAudio();
    if (timer.endAt) setTimer({ ...timer, remaining: remainingMs(), endAt: null });
    else setTimer({ ...timer, endAt: Date.now() + timer.remaining });
    renderTimer();
    startTicking();
  }
  function resetTimer() {
    if (!timer) return;
    setTimer({ ...timer, remaining: timer.total, endAt: null });
    renderTimer();
  }
  function addMinute() {
    if (!timer) return;
    const total = timer.total + 60000;
    if (timer.endAt) setTimer({ ...timer, total, endAt: timer.endAt + 60000 });
    else setTimer({ ...timer, total, remaining: timer.remaining + 60000 });
    renderTimer();
  }
  function timerDoneNow() {
    if (!timer) return;
    const id = timer.habitId;
    setTimer(null);
    markDone(id, keyOf(today()));
    closeSheet('#timer-sheet');
    toast('Marked done');
  }

  function primeAudio() {
    try {
      const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!audioCtx && Ctx) audioCtx = new Ctx();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    } catch (err) {
      console.info('Audio unavailable', err);
    }
  }
  function chime() {
    if (!audioCtx) return;
    [0, 0.25, 0.5].forEach((delay, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = [660, 880, 1320][i];
      gain.gain.setValueAtTime(0.25, audioCtx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + delay + 0.4);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(audioCtx.currentTime + delay);
      osc.stop(audioCtx.currentTime + delay + 0.45);
    });
  }

  /* ---------- reminders ---------- */
  function notifSupported() {
    return 'Notification' in globalThis;
  }
  async function ensurePermission() {
    if (!notifSupported()) {
      toast('Notifications are not supported here. Use "Add to calendar".');
      return false;
    }
    if (Notification.permission === 'granted') return true;
    try {
      const res = await Notification.requestPermission();
      renderNotifStatus();
      return res === 'granted';
    } catch (err) {
      console.warn(err);
      return false;
    }
  }

  async function notify(title, body) {
    if (!notifSupported() || Notification.permission !== 'granted') return;
    const opts = { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', vibrate: [200, 100, 200], tag: title };
    try {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) {
          await reg.showNotification(title, opts);
          return;
        }
      }
      new Notification(title, opts);
    } catch (err) {
      console.warn('Notification failed', err);
    }
  }

  function checkReminders() {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const tKey = keyOf(today());
    const fired = readJSON(FIRED_KEY, {});
    let changed = false;
    state.habits.forEach((h) => {
      const tag = `${h.id}|${tKey}`;
      const due = h.reminder && h.reminder <= hhmm && isScheduled(h, now) && !isDone(h, tKey) && !fired[tag];
      const recent = due && minutesBetween(h.reminder, hhmm) <= 30;
      if (due) {
        fired[tag] = 1;
        changed = true;
      }
      if (recent) notify(`${h.emoji} Time for ${h.name}`, h.duration ? `${h.duration} min · tap to open` : 'Tap to check it off');
    });
    if (changed) writeJSON(FIRED_KEY, pruneFired(fired, tKey));
  }
  function minutesBetween(a, b) {
    const [ah, am] = a.split(':').map(Number);
    const [bh, bm] = b.split(':').map(Number);
    return bh * 60 + bm - (ah * 60 + am);
  }
  function pruneFired(fired, tKey) {
    const out = {};
    Object.keys(fired).forEach((k) => {
      if (k.endsWith(tKey)) out[k] = 1;
    });
    return out;
  }

  function renderNotifStatus() {
    let msg = 'Notifications are not supported in this browser. Use "Add all to calendar" instead.';
    if (notifSupported()) {
      msg = {
        granted: '✅ Notifications on. Reminders pop up while Habitly is open or recently used.',
        denied: '🚫 Notifications are blocked. Turn them on in your phone settings for this app.',
        default: 'Tap "Allow notifications" so Habitly can remind you.',
      }[Notification.permission];
    }
    $('#s-notif-status').textContent = `${msg} For alarms that always ring, add reminders to your phone calendar too.`;
  }

  /* ---------- calendar (.ics) ---------- */
  function icsEvent(h) {
    const [hh, mm] = (h.reminder || defaultTime(h.tod)).split(':');
    const t = today();
    const start = `${keyOf(t).replaceAll('-', '')}T${hh}${mm}00`;
    const byDay = h.schedule.map((i) => ICS_DAYS[i]).join(',');
    const stamp = `${new Date().toISOString().replaceAll(/[-:]/g, '').split('.')[0]}Z`;
    return [
      'BEGIN:VEVENT',
      `UID:habitly-${h.id}@habitly`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${start}`,
      `DURATION:PT${h.duration || 10}M`,
      `RRULE:FREQ=WEEKLY;BYDAY=${byDay}`,
      `SUMMARY:${h.emoji} ${h.name.replaceAll(/[,;\\]/g, ' ')}`,
      'DESCRIPTION:Habit reminder from Habitly',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:Habit reminder',
      'TRIGGER:PT0M',
      'END:VALARM',
      'END:VEVENT',
    ];
  }
  function downloadIcs(habits, name) {
    if (!habits.length) {
      toast('Add a habit first');
      return;
    }
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Habitly//EN', 'CALSCALE:GREGORIAN'];
    habits.forEach((h) => lines.push(...icsEvent(h)));
    lines.push('END:VCALENDAR');
    const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `${name}.ics` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('Open the downloaded file to add it to your calendar');
  }
  function icsFromForm() {
    const data = readForm();
    if (!data.name || !data.schedule.length) {
      toast('Add a name and days first');
      return;
    }
    if (!data.reminder) data.reminder = $('#f-rem-time').value;
    downloadIcs([{ id: ui.editingId || 'new', ...data }], data.name.replaceAll(/\W+/g, '-').toLowerCase());
  }

  /* ---------- backup ---------- */
  async function exportBackup() {
    const text = JSON.stringify(state);
    const area = $('#s-text');
    try {
      await navigator.clipboard.writeText(text);
      toast('Backup copied — paste it somewhere safe');
    } catch (err) {
      console.warn('Clipboard blocked', err);
      area.value = text;
      area.classList.remove('hidden');
      area.select();
      toast('Select all and copy the text below');
    }
  }
  function showImport() {
    const area = $('#s-text');
    area.value = '';
    area.classList.remove('hidden');
    $('#s-import-go').classList.remove('hidden');
    area.focus();
  }
  function runImport() {
    try {
      const parsed = JSON.parse($('#s-text').value);
      if (!parsed || !Array.isArray(parsed.habits)) throw new Error('Invalid backup');
      state = { v: 2, habits: parsed.habits.map(migrate) };
      save();
      renderAll();
      $('#s-text').classList.add('hidden');
      $('#s-import-go').classList.add('hidden');
      closeSheet('#settings-sheet');
      toast('Backup restored');
    } catch (err) {
      console.warn(err);
      toast('That backup could not be read');
    }
  }

  /* ---------- misc ---------- */
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
  }

  function renderAll() {
    renderHome();
    if (ui.detailId && !$('#detail-sheet').classList.contains('hidden')) renderDetail();
  }

  function wireSheets() {
    document.querySelectorAll('.sheet-backdrop').forEach((bd) => {
      bd.addEventListener('click', (e) => {
        if (e.target === bd || e.target.closest('[data-close]')) bd.classList.add('hidden');
        if (bd.id === 'detail-sheet' && bd.classList.contains('hidden')) ui.detailId = null;
      });
    });
  }

  function wireInstall() {
    globalThis.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      ui.installEvt = e;
      $('#install-btn').classList.remove('hidden');
    });
    $('#install-btn').addEventListener('click', async () => {
      if (!ui.installEvt) return;
      ui.installEvt.prompt();
      await ui.installEvt.userChoice;
      ui.installEvt = null;
      $('#install-btn').classList.add('hidden');
    });
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch((err) => console.info('Service worker not registered', err));
    }
  }

  function wire() {
    $('#add-btn').addEventListener('click', () => openEditor(null));
    $('#settings-btn').addEventListener('click', () => {
      renderNotifStatus();
      openSheet('#settings-sheet');
    });
    $('#edit-form').addEventListener('submit', submitEditor);
    document.querySelectorAll('.quick [data-days]').forEach((b) =>
      b.addEventListener('click', () => setDays(b.dataset.days.split(',').map(Number)))
    );
    $('#f-dur-custom').addEventListener('input', () => {
      $('#f-dur').querySelectorAll('.sel').forEach((c) => c.classList.remove('sel'));
    });
    $('#f-ics').addEventListener('click', icsFromForm);
    $('#week-prev').addEventListener('click', () => {
      ui.weekOffset += 1;
      renderHome();
    });
    $('#week-next').addEventListener('click', () => {
      ui.weekOffset = Math.max(0, ui.weekOffset - 1);
      renderHome();
    });
    $('#week-label').addEventListener('click', () => {
      ui.weekOffset = 0;
      renderHome();
    });
    $('#m-prev').addEventListener('click', () => {
      ui.monthOffset += 1;
      renderDetail();
    });
    $('#m-next').addEventListener('click', () => {
      ui.monthOffset = Math.max(0, ui.monthOffset - 1);
      renderDetail();
    });
    $('#d-edit').addEventListener('click', () => openEditor(ui.detailId));
    $('#d-delete').addEventListener('click', askDelete);
    $('#d-timer').addEventListener('click', () => openTimer(ui.detailId));
    $('#c-ok').addEventListener('click', confirmDelete);
    $('#t-toggle').addEventListener('click', toggleTimer);
    $('#t-reset').addEventListener('click', resetTimer);
    $('#t-plus').addEventListener('click', addMinute);
    $('#t-done-now').addEventListener('click', timerDoneNow);
    $('#s-export').addEventListener('click', exportBackup);
    $('#s-import').addEventListener('click', showImport);
    $('#s-import-go').addEventListener('click', runImport);
    $('#s-notif').addEventListener('click', ensurePermission);
    $('#s-test').addEventListener('click', async () => {
      if (await ensurePermission()) notify('🔔 Habitly test', 'Reminders are working.');
    });
    $('#s-ics-all').addEventListener('click', () => downloadIcs(state.habits, 'habitly-reminders'));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      renderAll();
      checkTimer();
      checkReminders();
    });
    wireSheets();
    wireInstall();
  }

  wire();
  renderAll();
  if (timer) startTicking();
  checkReminders();
  setInterval(checkReminders, 20000);
})();
