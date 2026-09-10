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
  const dialog = document.getElementById('settings-dialog')!;
  const expand = document.getElementById('expand-settings')!;
  expand.addEventListener('click', () => {
    const expanded = dialog.classList.toggle('expanded');
    expand.setAttribute('aria-expanded', String(expanded));
    expand.textContent = expanded ? 'Compact' : 'Expand';
  });
}

export function arrangeFixtureSettings(panel:HTMLDetailsElement) {
  document.querySelector('[data-panel="fixtures"]')!.append(panel);
  panel.classList.add('fixture-panel');panel.querySelector('summary')!.textContent='Your fixtures';
  const body=panel.querySelector('.group-body')!;
  body.querySelector('p')!.textContent='Add a lamp or downlight at your current camera position. Up to eight lights.';
  const editor=document.createElement('div');editor.className='fixture-editor';
  for(const id of ['fixture-enabled','fixture-lumens','fixture-kelvin','fixture-beamDegrees'])editor.append(document.getElementById(id)!.closest('label')!);
  for(const [title,ids] of [['Position · metres',['x','y','z']],['Rotation · degrees',['pitch','yaw']]] as const){
    const group=document.createElement('div');group.className='fixture-vector';
    const heading=document.createElement('h4');heading.textContent=title;group.append(heading);
    for(const id of ids){const input=document.getElementById('fixture-'+id)!;const label=input.closest('label')!;label.firstChild!.textContent=id==='pitch'?'Tilt':id==='yaw'?'Rotation':id.toUpperCase();group.append(label);}
    editor.append(group);
  }
  body.append(editor);
  const empty=document.createElement('p');empty.className='fixture-empty';empty.textContent='No fixtures yet. Add a light above to start.';body.append(empty);
  const wall=document.getElementById('probe-wall-color')!.closest('label')!;wall.classList.add('wall-color');document.querySelector('[data-panel="materials"] .section-intro')!.after(wall);
  const refinement=document.querySelector('#probe-settings .group-body')!;
  for(const id of ['probe-strength','probe-view','probe-quality'])refinement.append(document.getElementById(id)!.closest('label')!);
  refinement.append(document.getElementById('probe-reset')!);
}
