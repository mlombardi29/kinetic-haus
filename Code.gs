/*************************************************************************
 * KINETIC HAUS — Google Apps Script backend
 * -----------------------------------------------------------------------
 * Reads/writes a Google Sheet that powers the Kinetic Haus workout app.
 *
 * SHEETS (auto-created on first run):
 *   • Logs      – one row PER SET (human-readable history)
 *   • Days      – one row PER EXERCISE in a workout-day template
 *   • Settings  – key/value (unit preference, etc.)
 *
 * DEPLOY (see SETUP.md for screenshots-style walkthrough):
 *   1. Open your Google Sheet → Extensions → Apps Script.
 *   2. Delete any sample code, paste this whole file, click Save.
 *   3. Click "Deploy" → "New deployment".
 *   4. Type = "Web app".
 *        - Description: Kinetic Haus
 *        - Execute as: Me
 *        - Who has access: Anyone
 *   5. Deploy → Authorize → copy the "Web app URL" (ends in /exec).
 *   6. Paste that URL into the app's Settings (gear icon).
 *
 * After changing this code you must "Deploy → Manage deployments →
 * edit (pencil) → Version: New version → Deploy" for changes to go live.
 *************************************************************************/

const SHEET_LOGS = 'Logs';
const SHEET_DAYS = 'Days';
const SHEET_SETTINGS = 'Settings';

const LOG_HEADERS = ['workoutId','date','workoutName','status','exercise','exerciseOrder',
                     'setNumber','weight','reps','unit','completed','exerciseNotes','workoutNotes','updatedAt','collapsed'];
const DAY_HEADERS = ['dayName','exercise','defaultSets','order'];
const SET_HEADERS = ['key','value'];

/* ------------------------- HTTP entry points ------------------------- */

function doGet(e){
  // If a data action is requested, return JSON (used by the standalone HTML).
  const action = e && e.parameter && e.parameter.action;
  if (action) {
    try {
      if (action === 'getData') return json(getData());
      return json({ ok:false, error:'Unknown action: ' + action });
    } catch (err) {
      return json({ ok:false, error:String(err) });
    }
  }
  // Otherwise serve the app page itself (ALL-IN-ONE mode).
  // Requires an HTML file named "Index" in this Apps Script project.
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Kinetic Haus')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e){
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = body.action;
    let result;
    switch (action){
      case 'saveWorkout':    result = saveWorkout(body.workout); break;
      case 'deleteWorkout':  result = deleteWorkout(body.workoutId); break;
      case 'saveDay':        result = saveDay(body.day, body.oldName); break;
      case 'deleteDay':      result = deleteDay(body.name); break;
      case 'saveSettings':   result = saveSettings(body.settings); break;
      case 'getData':        result = getData(); break;
      default:               result = { ok:false, error:'Unknown action: ' + action };
    }
    return json(result);
  } catch (err){
    return json({ ok:false, error:String(err) });
  }
}

/* ------------------------------ READ -------------------------------- */

function getData_L(){
  const ss = getSS();
  const logs = sheetRows(ss, SHEET_LOGS, LOG_HEADERS);
  const days = sheetRows(ss, SHEET_DAYS, DAY_HEADERS);
  const sett = sheetRows(ss, SHEET_SETTINGS, SET_HEADERS);

  // ---- group log rows into workouts ----
  const wmap = {};
  logs.forEach(r => {
    const id = r.workoutId; if (!id) return;
    if (!wmap[id]) wmap[id] = {
      workoutId:id, date:ymd(r.date), name:String(r.workoutName||''), status:r.status||'completed',
      notes:String(r.workoutNotes||''), updatedAt:Number(r.updatedAt)||0, exercises:[], _exidx:{}
    };
    const w = wmap[id];
    if (r.workoutNotes) w.notes = r.workoutNotes;
    if (Number(r.updatedAt) > w.updatedAt) w.updatedAt = Number(r.updatedAt);
    const exKey = r.exercise + '|' + r.exerciseOrder;
    if (w._exidx[exKey] === undefined){
      w._exidx[exKey] = w.exercises.length;
      w.exercises.push({ name:r.exercise, order:Number(r.exerciseOrder)||0, notes:r.exerciseNotes||'',
        collapsed: (r.collapsed===true || String(r.collapsed).toUpperCase()==='TRUE'), sets:[] });
    }
    const ex = w.exercises[w._exidx[exKey]];
    if (r.exerciseNotes) ex.notes = r.exerciseNotes;
    ex.sets.push({
      setNumber:Number(r.setNumber)||ex.sets.length+1,
      weight: r.weight===''?'':String(r.weight),
      reps:   r.reps===''?'':String(r.reps),
      unit:   r.unit || 'kg',
      completed: r.completed===true || String(r.completed).toUpperCase()==='TRUE'
    });
  });
  const workouts = Object.keys(wmap).map(id => {
    const w = wmap[id]; delete w._exidx;
    w.exercises.sort((a,b)=>a.order-b.order);
    w.exercises.forEach(ex => ex.sets.sort((a,b)=>a.setNumber-b.setNumber));
    return w;
  }).sort((a,b)=> String(b.date||'').localeCompare(String(a.date||'')) || (b.updatedAt||0)-(a.updatedAt||0));

  // ---- group day rows into templates ----
  const dmap = {};
  days.forEach(r => {
    const n = r.dayName; if (!n) return;
    if (!dmap[n]) dmap[n] = { name:n, exercises:[] };
    dmap[n].exercises.push({ name:r.exercise, sets:Number(r.defaultSets)||1, order:Number(r.order)||0 });
  });
  Object.values(dmap).forEach(d => d.exercises.sort((a,b)=>a.order-b.order));

  // ---- settings ----
  const settings = {};
  sett.forEach(r => { if (r.key) settings[r.key] = r.value; });
  if (!settings.unit) settings.unit = 'lbs';

  return { ok:true, workouts:workouts, days:dmap, settings:settings };
}

/* ------------------------------ WRITE ------------------------------- */

function saveWorkout_L(w){
  if (!w || !w.workoutId) return { ok:false, error:'Missing workout' };
  const sh = getSheet(getSS(), SHEET_LOGS, LOG_HEADERS);
  deleteWorkoutRows_(sh, w.workoutId);

  const now = Date.now();
  const rows = [];
  (w.exercises||[]).forEach((ex, ei) => {
    (ex.sets||[]).forEach((s, si) => {
      rows.push([
        w.workoutId, w.date||'', w.name||'', w.status||'in_progress',
        ex.name||'', (ex.order!=null?ex.order:ei),
        (s.setNumber!=null?s.setNumber:si+1),
        s.weight===''?'':Number(s.weight), s.reps===''?'':Number(s.reps),
        s.unit||'lbs', s.completed===true,
        ex.notes||'', w.notes||'', w.updatedAt||now, ex.collapsed===true
      ]);
    });
    // keep an exercise with zero sets so it isn't lost
    if (!(ex.sets||[]).length){
      rows.push([ w.workoutId, w.date||'', w.name||'', w.status||'in_progress',
        ex.name||'', (ex.order!=null?ex.order:ei), 1, '', '', 'lbs', false,
        ex.notes||'', w.notes||'', w.updatedAt||now, ex.collapsed===true ]);
    }
  });
  if (rows.length){
    sh.getRange(sh.getLastRow()+1, 1, rows.length, LOG_HEADERS.length).setValues(rows);
  }
  return { ok:true };
}

function deleteWorkout_L(workoutId){
  if (!workoutId) return { ok:false, error:'Missing workoutId' };
  const sh = getSheet(getSS(), SHEET_LOGS, LOG_HEADERS);
  deleteWorkoutRows_(sh, workoutId);
  return { ok:true };
}

function saveDay_L(day, oldName){
  if (!day || !day.name) return { ok:false, error:'Missing day' };
  const sh = getSheet(getSS(), SHEET_DAYS, DAY_HEADERS);
  if (oldName) deleteDayRows_(sh, oldName);
  deleteDayRows_(sh, day.name);
  const rows = (day.exercises||[]).map((e,i)=>[ day.name, e.name||'', Number(e.sets)||1, (e.order!=null?e.order:i) ]);
  if (rows.length){
    sh.getRange(sh.getLastRow()+1, 1, rows.length, DAY_HEADERS.length).setValues(rows);
  }
  return { ok:true };
}

function deleteDay_L(name){
  if (!name) return { ok:false, error:'Missing name' };
  deleteDayRows_(getSheet(getSS(), SHEET_DAYS, DAY_HEADERS), name);
  return { ok:true };
}

function saveSettings_L(settings){
  const sh = getSheet(getSS(), SHEET_SETTINGS, SET_HEADERS);
  const existing = sheetRows(getSS(), SHEET_SETTINGS, SET_HEADERS);
  const map = {}; existing.forEach(r=>{ if(r.key) map[r.key]=r.value; });
  Object.keys(settings||{}).forEach(k => map[k] = settings[k]);
  // rewrite whole settings sheet
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2,1,last-1,SET_HEADERS.length).clearContent();
  const rows = Object.keys(map).map(k => [k, map[k]]);
  if (rows.length) sh.getRange(2,1,rows.length,SET_HEADERS.length).setValues(rows);
  return { ok:true };
}

/* ----------------------------- helpers ------------------------------ */

function getSS(){ return SpreadsheetApp.getActiveSpreadsheet(); }

function getSheet(ss, name, headers){
  let sh = ss.getSheetByName(name);
  if (!sh){
    sh = ss.insertSheet(name);
    sh.getRange(1,1,1,headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() === 0){
    sh.getRange(1,1,1,headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  } else if (sh.getLastColumn() < headers.length){
    // migrate: widen header row when new columns are added (e.g. 'collapsed')
    sh.getRange(1,1,1,headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function sheetRows(ss, name, headers){
  const sh = getSheet(ss, name, headers);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2,1,last-1,headers.length).getValues();
  return values.map(row => {
    const o = {};
    headers.forEach((h,i)=> o[h] = row[i]);
    return o;
  }).filter(o => String(o[headers[0]]).length > 0);
}

function deleteWorkoutRows_(sh, workoutId){ deleteMatchingRows_(sh, 0, workoutId); }
function deleteDayRows_(sh, dayName){ deleteMatchingRows_(sh, 0, dayName); }

// delete all rows where column `col` (0-based) equals `value`
function deleteMatchingRows_(sh, col, value){
  const last = sh.getLastRow();
  if (last < 2) return;
  const data = sh.getRange(2,1,last-1,sh.getLastColumn()).getValues();
  for (let i = data.length - 1; i >= 0; i--){
    if (String(data[i][col]) === String(value)){
      sh.deleteRow(i + 2);
    }
  }
}

/* Serialize all reads/writes with a script lock so parallel requests can't
   interleave a delete-then-rewrite (which caused partially-saved workouts). */
function withLock(fn){
  const lock = LockService.getScriptLock();
  try { lock.waitLock(25000); } catch(e){ /* proceed unlocked rather than fail the request */ }
  try { return fn(); } finally { try { lock.releaseLock(); } catch(e){} }
}
function getData(){ return withLock(getData_L); }
function saveWorkout(w){ return withLock(function(){ return saveWorkout_L(w); }); }
function deleteWorkout(id){ return withLock(function(){ return deleteWorkout_L(id); }); }
function saveDay(day, oldName){ return withLock(function(){ return saveDay_L(day, oldName); }); }
function deleteDay(name){ return withLock(function(){ return deleteDay_L(name); }); }
function saveSettings(s){ return withLock(function(){ return saveSettings_L(s); }); }

/* Google Sheets often stores a date cell as a real Date value. Normalize any
   date (Date object OR text) to a plain 'YYYY-MM-DD' string so the app and the
   sort logic always work with text. */
function ymd(v){
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v || '');
}

function json(obj){
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================ DATA REPAIR ============================
 * ONE-TIME cleanup for the July 2026 duplicate-row glitch.
 * Run from the Apps Script editor: pick "runCleanupJuly2026" in the
 * function dropdown (next to Debug), press Run. Safe to run twice.
 *
 * What it does:
 *  1. Removes duplicate copies of the same set everywhere (keeps the
 *     newest copy of each set).
 *  2. Marks the July 4 "Chest & Arms" workout as completed.
 *  3. Replaces the glitched July 22 workout with the real session
 *     (as dictated by the owner on July 22, 2026).
 *  4. Drops blank spacer rows.
 * ==================================================================== */
function runCleanupJuly2026(){
  return withLock(function(){
    const sh = getSheet(getSS(), SHEET_LOGS, LOG_HEADERS);
    const last = sh.getLastRow();
    if (last < 2) return 'Logs sheet is empty — nothing to clean.';
    const data = sh.getRange(2,1,last-1,LOG_HEADERS.length).getValues();

    // 1) de-duplicate: keep the LAST copy of each workout+exercise+set
    const map = {}, order = [];
    data.forEach(r => {
      if (!String(r[0])) return;                       // skip blank rows
      const key = [r[0], r[4], r[5], r[6]].join('|');  // workoutId|exercise|order|setNumber
      if (!(key in map)) order.push(key);
      map[key] = r.slice();
    });
    let rows = order.map(k => map[k]);

    // 2) July 4 "Chest & Arms" was real training — mark it finished
    rows.forEach(r => { if (r[0] === 'w_mr6dju07le4ci') r[3] = 'completed'; });

    // 3) rebuild the July 22 session with the real sets
    const JUL22 = 'w_mrwg9fm1opdg0';
    const ts = rows.filter(r => r[0] === JUL22)
                   .reduce((m,r) => Math.max(m, Number(r[13])||0), Date.now());
    rows = rows.filter(r => r[0] !== JUL22);
    const EX = [ // [exercise, order, reps, weight, note]
      ['Chin-Ups',                 0,  6,  '', 'Wide grip'],
      ['One-Arm Dumbbell Rows',    1, 12,  55, ''],
      ['Reverse Flies',            2, 12,  70, ''],
      ['Shoulder Press',           3, 12, 140, ''],
      ['Lateral Raises',           4, 10,  40, ''],
      ['Russian Twists',           5, 25,  '', ''],
      ['Plank with Shoulder Taps', 6, 60,  '', ''],
      ['Abdominal crunch',         7, 14, 200, ''],
    ];
    EX.forEach(e => { for (let s = 1; s <= 3; s++){
      rows.push([JUL22, '2026-07-22', 'Back, Shoulders & Core', 'completed',
        e[0], e[1], s, e[3]===''?'':e[3], e[2], 'lbs', true, e[4], '', ts, true]);
    }});

    // 4) rewrite the whole sheet body
    sh.getRange(2,1,last-1,LOG_HEADERS.length).clearContent();
    if (rows.length) sh.getRange(2,1,rows.length,LOG_HEADERS.length).setValues(rows);
    return 'Cleanup done. Logs now has ' + rows.length + ' rows.';
  });
}

/* Optional: run once from the editor to pre-create the sheets/headers. */
function setup(){
  const ss = getSS();
  getSheet(ss, SHEET_LOGS, LOG_HEADERS);
  getSheet(ss, SHEET_DAYS, DAY_HEADERS);
  getSheet(ss, SHEET_SETTINGS, SET_HEADERS);
  saveSettings({ unit:'lbs' });
}
