/** Move existing controls without replacing their values or event handlers. */
export function arrangeSettings() {
  const lighting=document.querySelector('[data-panel="lighting"]')!;
  const card=document.createElement('div');card.className='lighting-method';
  const heading=document.createElement('span');heading.className='eyebrow';heading.textContent='LIGHTING METHOD';
  card.append(heading,document.getElementById('gi-mode')!.closest('label')!);
  const hint=document.createElement('p');hint.className='help';hint.textContent='Baked is the reference. Probe GI responds to lighting edits and needs time to prepare.';card.append(hint);
  lighting.querySelector('.section-intro')!.after(card);
  document.querySelector('.panel-header')!.after(document.getElementById('gi-status')!);
  const cycle=(document.getElementById('day-cycle') as HTMLInputElement).checked;
  for(const group of Array.from(lighting.querySelectorAll('details')))group.open=group.querySelector(cycle?'#day-time':'#sun-azimuth')!==null;
  const advanced=document.createElement('details');advanced.className='settings-group';advanced.id='probe-settings';advanced.innerHTML='<summary>Indirect lighting</summary><div class="group-body"></div>';lighting.append(advanced);
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
