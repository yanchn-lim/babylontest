/** Move existing controls without replacing their values or event handlers. */
export function arrangeSettings() {
  const panel = (name: string) => document.querySelector<HTMLElement>(`[data-panel="${name}"]`)!;
  function group(title: string, open = true) {
    const details = document.createElement('details');
    details.className = 'settings-group'; details.open = open;
    const summary = document.createElement('summary'); summary.textContent = title;
    const body = document.createElement('div'); body.className = 'group-body';
    details.append(summary, body);
    return { details, body };
  }
  const lighting = panel('lighting');
  const card = document.createElement('div'); card.className = 'lighting-method';
  const heading = document.createElement('span'); heading.className = 'eyebrow'; heading.textContent = 'INDIRECT LIGHTING';
  const hint = document.createElement('p'); hint.className = 'help';
  hint.textContent = 'Use baked lighting as a reference, or probe GI for changing sunlight and fixtures.';
  card.append(heading, document.getElementById('gi-mode')!.closest('label')!, hint, document.getElementById('gi-status')!);
  lighting.querySelector('.section-intro')!.after(card);
  for (const details of Array.from(lighting.querySelectorAll('details'))) details.open = true;
  const shadows = document.getElementById('shadows')!.closest('details')!;
  shadows.open = false;
  panel('quality').querySelector('details')!.after(shadows);
  const advanced = group('Probe controls', false); advanced.details.id = 'probe-settings';
  lighting.append(advanced.details);

  const image = panel('effects').querySelector('details')!;
  const tone = group('Camera response'), bloom = group('Bloom'), shafts = group('Sun shafts');
  let destination = tone.body;
  for (const child of Array.from(image.querySelector('.group-body')!.children)) {
    if (child.querySelector('#bloom-enabled')) destination = bloom.body;
    if (child.querySelector('#shafts')) destination = shafts.body;
    destination.append(child);
  }
  image.replaceWith(tone.details, bloom.details, shafts.details);
  panel('quality').querySelector('.group-body')!.prepend(document.querySelector('.stats')!);

  const camera = panel('scene').querySelector('.group-body')!;
  camera.append(document.getElementById('capture-mouse')!);
  for (const hint of Array.from(document.querySelectorAll('.desktop-hint, .mobile-hint'))) camera.append(hint);
  const session = group('Session', false);
  session.body.append(document.getElementById('reset-graphics')!, document.querySelector('.save-note')!, document.getElementById('model-source')!);
  panel('scene').append(session.details);
  // Keep ordinary editing separate from technical inspection.
  const debugPanel = document.createElement('section'); debugPanel.dataset.panel = 'debug'; debugPanel.hidden = true;
  debugPanel.innerHTML = '<div class="section-intro"><h3>Debug & diagnostics</h3><p>Frame intervals are not whole-frame GPU timings.</p></div>';
  document.getElementById('controls')!.append(debugPanel);
  const debugTab = document.createElement('button'); debugTab.type = 'button'; debugTab.dataset.section = 'debug'; debugTab.textContent = 'Debug'; debugTab.hidden = true;
  document.querySelector('.panel-nav')!.append(debugTab);
  const tools = group('Diagnostics'); tools.body.id = 'debug-tools';
  const readings = document.createElement('dl'); readings.id = 'debug-readings'; readings.className = 'diagnostic-list';
  for (const [key, label] of [['probeGpuMs','Last GI dispatch'],['shadowMapRenders','Shadow renders'],['graphBuilds','Graph builds'],['probeError','GI error']]) {
    const row = document.createElement('div'), term = document.createElement('dt'), value = document.createElement('dd');
    term.textContent = label; value.dataset.diagnostic = key; value.textContent = 'Unavailable'; row.append(term, value); readings.append(row);
  }
  tools.body.append(readings, document.getElementById('renderer')!.parentElement!, document.getElementById('inspector')!);
  debugPanel.append(tools.details, document.getElementById('benchmark-mode')!.closest('details')!);
  const overlay = document.createElement('div'); overlay.id = 'debug-overlay'; overlay.hidden = true; overlay.setAttribute('aria-label', 'Live diagnostics');
  overlay.append(document.querySelector('.stats')!);
  const meta = document.createElement('p'); meta.id = 'debug-summary'; meta.className = 'help'; overlay.append(meta);
  document.querySelector('.hud')!.append(overlay);
  const toggle = document.createElement('button'); toggle.id = 'toggle-debug'; toggle.type = 'button'; toggle.textContent = 'Debug'; toggle.setAttribute('aria-pressed', 'false');
  toggle.setAttribute('aria-controls', 'debug-overlay'); document.querySelector('.hud-heading')!.append(toggle);
  const run = document.createElement('div'); run.id = 'benchmark-active'; run.hidden = true;
  run.append(document.getElementById('benchmark-hud')!, document.getElementById('benchmark-stop')!); document.querySelector('.hud')!.append(run);

  const move = (id: string, target: Element) => target.append(document.getElementById(id)!.closest('label')!);
  const playback = group('Playback settings', false); move('day-length', playback.body);
  document.getElementById('day-play')!.after(playback.details);
  const fill = document.getElementById('environment-intensity')!.closest('details')!; fill.open = false;
  fill.querySelector('summary')!.textContent = 'Advanced environment fill';
  const shadowAdvanced = group('Advanced shadows', false);
  for (const id of ['shadow-filter','shadow-softness','shadow-bias','shadow-normal-bias']) move(id, shadowAdvanced.body);
  for (const help of Array.from(shadows.querySelectorAll('.help'))) shadowAdvanced.body.append(help);
  shadows.open = true; shadows.querySelector('.group-body')!.append(shadowAdvanced.details);
  for (const [details, ids] of [[bloom.details, ['bloom-threshold','bloom-radius']], [shafts.details, ['shaft-scattering']]] as const) {
    const extra = group('Advanced', false);
    for (const id of ids) move(id, extra.body);
    for (const help of Array.from(details.querySelectorAll('.help'))) extra.body.append(help);
    details.querySelector('.group-body')!.append(extra.details);
  }
  const materialHelp = group('About material edits', false);
  const materialBody = panel('materials').querySelector('.group-body')!;
  for (const help of Array.from(materialBody.querySelectorAll(':scope > .help:not(#material-description)'))) materialHelp.body.append(help);
  materialBody.append(materialHelp.details);
  const modeHelp = document.createElement('p'); modeHelp.className = 'help'; modeHelp.id = 'sun-mode-help';
  document.getElementById('sun-azimuth')!.closest('.group-body')!.prepend(modeHelp);
  const explainMode = () => { modeHelp.textContent = (document.getElementById('day-cycle') as HTMLInputElement).checked
    ? 'Time of day controls direction and warmth. Turn it off to set these manually.' : 'Manual direction and warmth. Enable time of day to follow the day cycle.'; };
  for (const [id, label] of [['sun-azimuth','Sun azimuth (°)'],['sun-elevation','Sun elevation (°)'],['material-roughness','Roughness multiplier (×)'],['material-normal','Texture detail multiplier (×)'],['material-reflection','Reflection multiplier (×)']]) {
    const input = document.getElementById(id)!; input.closest('label')!.firstChild!.textContent = label + ' '; input.setAttribute('aria-label', label);
  }
  const appearance = group('UI appearance', false);
  appearance.body.innerHTML = '<label>Panel opacity <output id="panel-opacity-value">88%</output><input id="panel-opacity" aria-label="Panel opacity" type="range" min="70" max="100" step="1" value="88"></label><p class="help">Only the panel background changes. Controls remain solid.</p>';
  panel('scene').append(appearance.details);

  const dialog = document.getElementById('settings-dialog') as HTMLDialogElement;
  const canvas = document.getElementById('scene')!;
  const toolbar = document.querySelector<HTMLElement>('.hud')!;
  const toolbarObserver = new ResizeObserver(() => dialog.style.setProperty('--toolbar-bottom', (toolbar.getBoundingClientRect().bottom + 8) + 'px'));
  toolbarObserver.observe(toolbar);
  const expand = document.getElementById('expand-settings')!;
  const opacity = document.getElementById('panel-opacity') as HTMLInputElement;
  const nav = document.querySelector('.panel-nav')!;
  const categories = ['lighting','fixtures','materials','effects','quality','scene'];
  const storageKey = 'babylon-ui-v1';
  let saved: Record<string, unknown> = {};
  try { const value = JSON.parse(localStorage.getItem(storageKey) || '{}'); if (value && typeof value === 'object') saved = value; } catch { /* Storage is optional. */ }
  let category = typeof saved.category === 'string' && categories.includes(saved.category) ? saved.category : 'lighting';
  let expanded = saved.expanded === true, debugging = false;
  let resetInput = () => {}, closeInspector = () => {};
  const abort = new AbortController(), options = { signal: abort.signal };
  opacity.value = String(typeof saved.opacity === 'number' && Number.isFinite(saved.opacity) ? Math.max(70, Math.min(100, saved.opacity)) : 88);
  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify({ category: category === 'debug' ? 'lighting' : category, expanded, opacity: Number(opacity.value) })); } catch { /* Storage is optional. */ }
  }
  function revealCategory() {
    const active = nav.querySelector<HTMLElement>('[aria-pressed="true"]');
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function select(next: string) {
    category = next;
    for (const item of Array.from(document.querySelectorAll<HTMLElement>('[data-panel]'))) item.hidden = item.dataset.panel !== category;
    for (const item of Array.from(nav.querySelectorAll<HTMLElement>('[data-section]'))) item.setAttribute('aria-pressed', String(item.dataset.section === category));
    document.querySelector('.panel-body')!.scrollTop = 0;
    revealCategory(); save();
  }
  function appearanceState() {
    dialog.classList.toggle('expanded', expanded);
    expand.setAttribute('aria-expanded', String(expanded)); expand.textContent = expanded ? 'Compact' : 'Expand';
    dialog.style.setProperty('--panel-opacity', String(Number(opacity.value) / 100));
    document.getElementById('panel-opacity-value')!.textContent = opacity.value + '%';
  }
  function show() {
    resetInput(); if (document.pointerLockElement) document.exitPointerLock();
    if (!dialog.open) dialog.show();
    document.getElementById('open-settings')!.setAttribute('aria-expanded', 'true');
    document.getElementById('close-settings')!.focus(); revealCategory();
  }
  function hide() { dialog.close(); }
  function setDebug(value: boolean) {
    debugging = value; overlay.hidden = debugTab.hidden = !value;
    toggle.setAttribute('aria-pressed', String(value));
    if (!value) {
      const view = document.getElementById('probe-view') as HTMLSelectElement | null;
      if (view && view.value !== 'combined') { view.value = 'combined'; view.dispatchEvent(new Event('input', { bubbles: true })); }
      closeInspector(); if (category === 'debug') select('lighting');
    }
  }
  const labels: Record<string, string> = { lighting: 'Environment', fixtures: 'Lights', materials: 'Materials' };
  for (const button of Array.from(nav.querySelectorAll<HTMLButtonElement>('[data-section]'))) {
    button.textContent = labels[button.dataset.section!] || button.textContent;
    button.addEventListener('click', () => select(button.dataset.section!), options);
  }
  document.getElementById('open-settings')!.textContent = 'Controls';
  document.getElementById('close-settings')!.textContent = 'Close';
  document.getElementById('settings-title')!.textContent = 'Environment controls';
  document.getElementById('open-settings')!.addEventListener('click', show, options);
  document.getElementById('close-settings')!.addEventListener('click', hide, options);
  dialog.addEventListener('close', () => { resetInput(); document.getElementById('open-settings')!.setAttribute('aria-expanded', 'false'); canvas.focus(); }, options);
  window.addEventListener('keydown', event => { if (event.key === 'Escape' && dialog.open) { event.preventDefault(); hide(); } }, options);
  window.addEventListener('resize', () => { if (dialog.open) { resetInput(); revealCategory(); } }, options);
  expand.addEventListener('click', () => { expanded = !expanded; resetInput(); appearanceState(); revealCategory(); save(); }, options);
  opacity.addEventListener('input', appearanceState, options);
  opacity.addEventListener('change', save, options);
  toggle.addEventListener('click', () => setDebug(!debugging), options);
  document.getElementById('day-cycle')!.addEventListener('change', explainMode, options);
  explainMode(); appearanceState(); select(category);
  return {
    show, hide, setDebug,
    get debugging() { return debugging; },
    connect(hooks: { resetInput: () => void; closeInspector: () => void }) { resetInput = hooks.resetInput; closeInspector = hooks.closeInspector; },
    updateDiagnostics(data: Record<string, unknown>) {
      const status = document.getElementById('status')!;
      const realtime = data.mode === 'realtime';
      const busy = realtime && (data.probePhase === 'preparing' || data.probePhase === 'refining');
      if (data.probeError || busy) {
        status.hidden = false; status.dataset.giStatus = 'true';
        status.classList.toggle('error', !!data.probeError);
        const text = data.probeError ? String(data.probeError) : data.probePhase === 'preparing' ? 'Preparing lighting…' : `Updating lighting · ${Math.round(Number(data.probeProgress || 0) * 100)}%`;
        if (status.textContent !== text) status.textContent = text;
      } else if (status.dataset.giStatus) { delete status.dataset.giStatus; status.hidden = true; status.classList.remove('error'); }
      if (!debugging) return;
      const number = (key: string, digits = 1) => typeof data[key] === 'number' && Number.isFinite(data[key]) ? (data[key] as number).toFixed(digits) : 'Unavailable';
      document.getElementById('fps')!.textContent = number('fps', 0);
      document.getElementById('frame')!.textContent = number('frameMs') + ' ms';
      document.getElementById('resolution')!.textContent = `${data.width} × ${data.height}`;
      meta.textContent = `${data.renderer} · GI: ${realtime ? data.probePhase || 'unavailable' : data.mode || 'unavailable'}${realtime && typeof data.probeProgress === 'number' ? ' ' + Math.round(data.probeProgress * 100) + '%' : ''}`;
      for (const node of Array.from(readings.querySelectorAll<HTMLElement>('[data-diagnostic]'))) {
        const key = node.dataset.diagnostic!;
        node.textContent = key === 'probeGpuMs' ? (Number(data[key]) > 0 ? number(key, 3) + ' ms (retained)' : 'Unavailable') : key === 'probeError' ? String(data[key] || 'None') : number(key, 0);
      }
    },
    dispose() { toolbarObserver.disconnect(); setDebug(false); resetInput(); abort.abort(); if (dialog.open) dialog.close(); }
  };
}

export function arrangeFixtureSettings(panel:HTMLDetailsElement) {
  document.querySelector('[data-panel="fixtures"]')!.append(panel);
  panel.classList.add('fixture-panel');panel.querySelector('summary')!.textContent='Your fixtures';
  const body=panel.querySelector('.group-body')!;
  body.querySelector('p')!.textContent='Add a lamp or downlight at your current camera position. Up to eight lights.';
  const editor=document.createElement('div');editor.className='fixture-editor';
  for(const id of ['fixture-enabled','fixture-lumens','fixture-kelvin'])editor.append(document.getElementById(id)!.closest('label')!);
  const advanced=document.createElement('details');advanced.className='settings-group fixture-advanced';advanced.innerHTML='<summary>Position & beam</summary><div class="group-body"></div>';
  const advancedBody=advanced.querySelector('.group-body')!;advancedBody.append(document.getElementById('fixture-beamDegrees')!.closest('label')!);
  for(const [title,ids] of [['Position · metres',['x','y','z']],['Rotation · degrees',['pitch','yaw']]] as const){
    const group=document.createElement('div');group.className='fixture-vector';
    const heading=document.createElement('h4');heading.textContent=title;group.append(heading);
    for(const id of ids){const input=document.getElementById('fixture-'+id)!;const label=input.closest('label')!;label.firstChild!.textContent=id==='pitch'?'Tilt':id==='yaw'?'Rotation':id.toUpperCase();group.append(label);}
    advancedBody.append(group);
  }
  editor.append(advanced);
  body.append(editor);
  const empty=document.createElement('p');empty.className='fixture-empty';empty.textContent='No fixtures yet. Add a light above to start.';body.append(empty);
  const wall=document.getElementById('probe-wall-color')!.closest('label')!;wall.classList.add('wall-color');document.querySelector('[data-panel="materials"] .section-intro')!.after(wall);
  const refinement=document.querySelector('#probe-settings .group-body')!;
  document.querySelector('.lighting-method')!.append(document.getElementById('probe-strength')!.closest('label')!);
  document.getElementById('debug-tools')!.append(document.getElementById('probe-view')!.closest('label')!);
  refinement.append(document.getElementById('probe-quality')!.closest('label')!);
  refinement.append(document.getElementById('probe-reset')!);
}
