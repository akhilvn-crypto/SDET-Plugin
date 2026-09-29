#!/usr/bin/env node
/**
 * mobile.js - deterministic helper for /mobile-automate (Appium + Java, Android).
 *
 * Zero dependencies (Node 18+ for global fetch). Run from the TARGET PROJECT root:
 *   node "${CLAUDE_PLUGIN_ROOT}/scripts/mobile.js" <command> [options]
 *
 * Environment
 *   doctor [--json]                          Check every dependency (JDK, Maven, Android SDK, adb,
 *                                            Node, Appium, UiAutomator2 driver). Exit 1 if a required one is missing.
 *   devices [--json]                         List connected devices/emulators with Android version.
 *   avds                                     List emulator AVDs that could be booted.
 *   foreground [--udid <id>]                 The package/activity currently on screen.
 *   app --package <pkg> [--activity <act>] [--udid <id>]
 *                                            Is the app installed? Version, launcher activity, does <act> exist?
 *   appid <package>                          Suggest a test-case id prefix from a package name.
 *   config show | set key=value...           Remembered app settings (appId, appPackage, appActivity, udid,
 *                                            appiumUrl, projectDir). Stored in sdet.config.json "mobile" when the
 *                                            project has one, else .sdet/mobile/app.json.
 *   server status [--url <appium url>]       Is an Appium server answering?
 *
 * Exploration session (W3C WebDriver over HTTP to the Appium server; state in .sdet/mobile/session.json)
 *   session start --package <pkg> --activity <act> [--udid <id>] [--url <u>] [--reset]
 *   session status | end
 *   session source [--raw] [--out <file>]    Compact list of on-screen elements with suggested locators.
 *   session screenshot --out <file.png>
 *   session activity                         Current package + activity.
 *   session find  --by <id|desc|text|xpath|uiautomator|class> --value <v>
 *   session tap   --by <...> --value <v> [--index n]
 *   session type  --by <...> --value <v> --text <t>
 *   session back | hide-keyboard | relaunch
 *   session swipe --dir <up|down|left|right>
 *
 * Mobile test cases (test-cases/mobile/<APP_ID>.test-cases.json + rendered .md)
 *   testcases path|validate|render <APP_ID>
 *   testcases approve <APP_ID> [--by <name>] | reject <APP_ID> --note "<why>" | status <APP_ID>
 *
 * Results (TestNG report of the Maven project -> test cases)
 *   results summary [--project <dir>]
 *   results ingest <APP_ID> [--project <dir>]
 *   results classify <APP_ID> <TC_ID> <CATEGORY> [--actual "<plain words>"] [--issue BUG-NNN]...
 *   results pending <APP_ID>                 Prints OK when every failure is classified.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CWD = process.cwd();
const IS_WIN = process.platform === 'win32';
const STATE_DIR = path.join(CWD, '.sdet', 'mobile');
const SESSION_FILE = path.join(STATE_DIR, 'session.json');
const DEFAULT_URL = 'http://127.0.0.1:4723';
const DEFAULT_PROJECT = 'mobile-tests';
const TC_DIR = path.join('test-cases', 'mobile');
const CATEGORIES = [
  'APPLICATION_DEFECT', 'LOCATOR_FAILURE', 'ASSERTION_FAILURE', 'TIMING_FAILURE', 'TEST_DATA_FAILURE',
  'ENVIRONMENT_FAILURE', 'DEVICE_FAILURE', 'APP_CRASH', 'FLAKY', 'UNKNOWN',
];

// ---------------------------------------------------------------- helpers

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    const value = next === undefined || next.startsWith('--') ? true : (i++, next);
    if (key in out) out[key] = [].concat(out[key], value);
    else out[key] = value;
  }
  return out;
}

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function run(cmd, args, opts = {}) {
  // .cmd/.bat shims (appium, mvn, npm) need a shell on Windows.
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: IS_WIN, timeout: opts.timeout || 60000, windowsHide: true });
  if (r.error) return { ok: false, out: '', err: String(r.error.message || r.error), code: -1 };
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), code: r.status };
}

function sdkRoot() {
  return process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || null;
}

function adbBin() {
  const root = sdkRoot();
  const local = root && path.join(root, 'platform-tools', IS_WIN ? 'adb.exe' : 'adb');
  if (local && fs.existsSync(local)) return local;
  return 'adb';
}

function adb(args, udid) {
  return run(adbBin(), udid ? ['-s', udid, ...args] : args, { timeout: 30000 });
}

function shell(udid, command) {
  return adb(['shell', command], udid).out.replace(/\r/g, '');
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function versionMajor(text) {
  const m = String(text).match(/version "?(\d+)(?:\.(\d+))?/i) || String(text).match(/(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  const major = Number(m[1]);
  return major === 1 && m[2] ? Number(m[2]) : major; // "1.8" -> 8
}

function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

// ---------------------------------------------------------------- doctor

function doctor(opts) {
  const checks = [];
  const add = (c) => checks.push({ required: true, ...c });

  const nodeV = process.version;
  add({
    name: 'Node.js', found: nodeV, ok: cmpVersion(nodeV, '20.19.0') >= 0,
    fix: 'Install Node.js 20.19+ (Appium 3 requirement) from https://nodejs.org',
  });

  const java = run('java', ['-version']);
  const javaText = java.err || java.out;
  const javaMajor = java.code === -1 ? null : versionMajor(javaText);
  add({
    name: 'Java JDK (11+)', found: javaMajor ? javaText.split('\n')[0] : 'not found', ok: !!javaMajor && javaMajor >= 11,
    fix: 'Install a JDK 17+ (e.g. Eclipse Temurin) and put its bin/ on PATH.',
  });

  const javaHome = process.env.JAVA_HOME;
  add({
    name: 'JAVA_HOME', found: javaHome || 'not set', ok: !!javaHome && fs.existsSync(javaHome),
    fix: 'Set JAVA_HOME to the JDK install folder (UiAutomator2 uses it to sign its server APK).',
  });

  const mvnw = fs.existsSync(path.join(CWD, DEFAULT_PROJECT, IS_WIN ? 'mvnw.cmd' : 'mvnw'));
  const mvn = run('mvn', ['-v']);
  add({
    name: 'Maven', found: mvn.ok ? mvn.out.split('\n')[0] : mvnw ? 'Maven wrapper in mobile-tests/' : 'not found', ok: mvn.ok || mvnw,
    fix: 'Install Apache Maven 3.9+ and put its bin/ on PATH (https://maven.apache.org/download.cgi).',
  });

  const root = sdkRoot();
  add({
    name: 'ANDROID_HOME / ANDROID_SDK_ROOT', found: root || 'not set', ok: !!root && fs.existsSync(root),
    fix: 'Install the Android SDK (Android Studio or command-line tools) and set ANDROID_HOME to it.',
  });

  let buildTools = null;
  if (root) {
    const dir = path.join(root, 'build-tools');
    if (fs.existsSync(dir)) buildTools = fs.readdirSync(dir).sort((a, b) => cmpVersion(b, a))[0] || null;
  }
  add({
    name: 'Android build-tools', found: buildTools || 'not found', ok: !!buildTools,
    fix: 'sdkmanager "build-tools;34.0.0" (UiAutomator2 needs apksigner/aapt from build-tools).',
  });

  const adbV = adb(['version']);
  add({
    name: 'adb (platform-tools)', found: adbV.ok ? adbV.out.split('\n')[0] : 'not found', ok: adbV.ok,
    fix: 'sdkmanager "platform-tools", and add %ANDROID_HOME%/platform-tools to PATH.',
  });

  const appium = run('appium', ['-v']);
  const appiumV = appium.ok ? appium.out.split('\n').pop().trim() : null;
  add({
    name: 'Appium server (2.x/3.x)', found: appiumV || 'not found', ok: !!appiumV && cmpVersion(appiumV, '2.0.0') >= 0,
    fix: 'npm install -g appium',
  });

  let uia2 = null;
  if (appiumV) {
    const list = run('appium', ['driver', 'list', '--installed', '--json'], { timeout: 90000 });
    const json = (() => { try { return JSON.parse(list.out.slice(list.out.indexOf('{'))); } catch { return null; } })();
    if (json && json.uiautomator2) uia2 = json.uiautomator2.version || 'installed';
    else if (/uiautomator2/i.test(list.out + list.err)) uia2 = 'installed';
  }
  add({
    name: 'Appium UiAutomator2 driver', found: uia2 || 'not installed', ok: !!uia2,
    fix: 'appium driver install uiautomator2',
  });

  const emulator = root && ['emulator', 'tools'].map((d) => path.join(root, d, IS_WIN ? 'emulator.exe' : 'emulator')).find(fs.existsSync);
  add({ name: 'Android emulator (optional)', found: emulator || 'not found', ok: !!emulator, required: false,
    fix: 'Optional - only needed to boot an emulator instead of a USB device: sdkmanager "emulator".' });

  const missing = checks.filter((c) => c.required && !c.ok);
  if (opts.json) console.log(JSON.stringify({ ok: !missing.length, checks }, null, 2));
  else {
    for (const c of checks) console.log(`${c.ok ? 'OK  ' : c.required ? 'MISS' : 'WARN'}  ${c.name.padEnd(34)} ${c.found}`);
    if (missing.length) {
      console.log('\nTo fix:');
      for (const c of missing) console.log(`- ${c.name}: ${c.fix}`);
    } else console.log('\nAll required dependencies are available.');
  }
  process.exit(missing.length ? 1 : 0);
}

// ---------------------------------------------------------------- devices / app

function listDevices() {
  const r = adb(['devices', '-l']);
  if (!r.ok) return { error: 'adb is not available', devices: [] };
  const devices = r.out.split('\n').slice(1).map((l) => l.trim()).filter(Boolean).map((line) => {
    const [serial, state, ...rest] = line.split(/\s+/);
    const props = Object.fromEntries(rest.map((kv) => kv.split(':')).filter((p) => p.length === 2));
    const d = { udid: serial, state, model: props.model || null, emulator: serial.startsWith('emulator-') };
    if (state === 'device') {
      d.androidVersion = shell(serial, 'getprop ro.build.version.release').trim();
      d.apiLevel = Number(shell(serial, 'getprop ro.build.version.sdk').trim()) || null;
      d.model = shell(serial, 'getprop ro.product.model').trim() || d.model;
    } else if (state === 'unauthorized') {
      d.fix = 'Unlock the device and accept the "Allow USB debugging?" prompt.';
    } else if (state === 'offline') {
      d.fix = 'Reconnect the cable, or run: adb kill-server && adb start-server';
    }
    return d;
  });
  return { devices };
}

function devices(opts) {
  const { error, devices: list } = listDevices();
  if (opts.json) return console.log(JSON.stringify({ error: error || null, devices: list }, null, 2));
  if (error) die(error);
  if (!list.length) {
    console.log('No device connected.');
    console.log('- USB device: enable Developer options > USB debugging, connect it, accept the prompt.');
    console.log('- Emulator: `node mobile.js avds`, then `emulator -avd <name>`.');
    process.exit(2);
  }
  for (const d of list) {
    console.log(`${d.udid.padEnd(24)} ${d.state.padEnd(13)} ${d.model || ''}${d.androidVersion ? ` Android ${d.androidVersion} (API ${d.apiLevel})` : ''}${d.emulator ? ' [emulator]' : ''}${d.fix ? `  -> ${d.fix}` : ''}`);
  }
  if (!list.some((d) => d.state === 'device')) process.exit(2);
}

function avds() {
  const root = sdkRoot();
  const bin = root && ['emulator', 'tools'].map((d) => path.join(root, d, IS_WIN ? 'emulator.exe' : 'emulator')).find(fs.existsSync);
  const r = run(bin || 'emulator', ['-list-avds']);
  if (!r.ok) die('The Android emulator is not installed (sdkmanager "emulator").');
  console.log(r.out || 'No AVDs defined - create one in Android Studio > Device Manager.');
}

function pickUdid(opts) {
  if (opts.udid && opts.udid !== true) return opts.udid;
  const ready = listDevices().devices.filter((d) => d.state === 'device');
  if (ready.length === 1) return ready[0].udid;
  if (!ready.length) die('No connected device in "device" state (run: mobile.js devices).', 2);
  die(`More than one device is connected - pass --udid (one of: ${ready.map((d) => d.udid).join(', ')}).`, 2);
}

function foreground(opts) {
  const udid = pickUdid(opts);
  const acts = shell(udid, 'dumpsys activity activities');
  let m = acts.match(/(?:topResumedActivity|mResumedActivity|ResumedActivity)[^\n]*?\s([\w.]+)\/([\w.$]+)/);
  if (!m) m = shell(udid, 'dumpsys window').match(/mCurrentFocus[^\n]*?\s([\w.]+)\/([\w.$]+)/);
  if (!m) die('Could not read the foreground app - unlock the device and open the app first.');
  const activity = m[2].startsWith('.') ? m[1] + m[2] : m[2];
  console.log(JSON.stringify({ udid, package: m[1], activity }, null, 2));
}

function fullActivity(pkg, act) {
  return act.startsWith('.') ? pkg + act : act.includes('.') ? act : `${pkg}.${act}`;
}

function appInfo(opts) {
  const pkg = opts.package;
  if (!pkg || pkg === true) die('Usage: mobile.js app --package <pkg> [--activity <act>] [--udid <id>]');
  const udid = pickUdid(opts);
  const installed = shell(udid, `pm list packages ${pkg}`).split('\n').some((l) => l.trim() === `package:${pkg}`);
  const info = { udid, package: pkg, installed, versionName: null, launcherActivity: null, activity: null, activityFound: null };
  if (installed) {
    const dump = shell(udid, `dumpsys package ${pkg}`);
    info.versionName = (dump.match(/versionName=(\S+)/) || [])[1] || null;
    const resolved = shell(udid, `cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${pkg}`).trim().split('\n').pop();
    if (resolved && resolved.includes('/')) info.launcherActivity = fullActivity(pkg, resolved.split('/')[1]);
    if (opts.activity && opts.activity !== true) {
      info.activity = fullActivity(pkg, opts.activity);
      const shortName = info.activity.startsWith(pkg) ? info.activity.slice(pkg.length) : null;
      info.activityFound = dump.includes(info.activity) || (shortName != null && dump.includes(`${pkg}/${shortName}`));
    }
  }
  console.log(JSON.stringify(info, null, 2));
  if (!installed) process.exit(3);
  if (info.activityFound === false) process.exit(4);
}

function appid(pkg) {
  if (!pkg) die('Usage: mobile.js appid <package>');
  const skip = new Set(['com', 'org', 'net', 'io', 'app', 'android', 'mobile', 'debug', 'release', 'dev', 'qa', 'staging']);
  const parts = pkg.split('.').filter((p) => !skip.has(p.toLowerCase()));
  let id = (parts.pop() || pkg.split('.').pop()).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[A-Z]/.test(id)) id = `APP-${id}`;
  console.log(id);
}

// ---------------------------------------------------------------- remembered settings

const MOBILE_DEFAULTS = {
  platform: 'android', appId: null, appPackage: null, appActivity: null, udid: null,
  appiumUrl: DEFAULT_URL, projectDir: DEFAULT_PROJECT, apkPath: null,
};
const PROJECT_CONFIG = path.join(CWD, 'sdet.config.json');
const LOCAL_CONFIG = path.join(STATE_DIR, 'app.json');

function mobileConfig() {
  const project = readJson(PROJECT_CONFIG);
  const local = readJson(LOCAL_CONFIG) || {};
  return { ...MOBILE_DEFAULTS, ...local, ...((project && project.mobile) || {}) };
}

function config(sub, pairs) {
  if (sub === 'show' || !sub) {
    const where = fs.existsSync(PROJECT_CONFIG) ? 'sdet.config.json (mobile)' : path.relative(CWD, LOCAL_CONFIG);
    return console.log(JSON.stringify({ storedIn: where, ...mobileConfig() }, null, 2));
  }
  if (sub !== 'set' || !pairs.length) die('Usage: mobile.js config show | set key=value [key=value...]');
  const updates = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    const key = i > 0 ? p.slice(0, i) : null;
    if (!key || !(key in MOBILE_DEFAULTS)) die(`Unknown mobile setting "${p}". Keys: ${Object.keys(MOBILE_DEFAULTS).join(', ')}`);
    const value = p.slice(i + 1).trim();
    updates[key] = value === '' || value === 'null' ? null : value;
  }
  if (updates.appId && !/^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*$/.test(updates.appId)) die(`appId "${updates.appId}" must look like SHOP or MY-APP (capitals, digits, dashes).`);
  const project = readJson(PROJECT_CONFIG);
  if (project) {
    project.mobile = { ...MOBILE_DEFAULTS, ...(project.mobile || {}), ...updates };
    writeJson(PROJECT_CONFIG, project);
  } else {
    writeJson(LOCAL_CONFIG, { ...MOBILE_DEFAULTS, ...(readJson(LOCAL_CONFIG) || {}), ...updates });
  }
  config('show', []);
}

// ---------------------------------------------------------------- Appium HTTP

async function http(method, url, body) {
  let res;
  try {
    res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new Error(`Cannot reach the Appium server at ${url.split('/session')[0]} (${e.cause ? e.cause.code || e.cause.message : e.message}). Start it with: appium --address 127.0.0.1 --port 4723`);
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { value: text }; }
  if (!res.ok || (json.value && json.value.error)) {
    const v = json.value || {};
    throw new Error(`${v.error || res.status}: ${String(v.message || text).split('\n')[0]}`);
  }
  return json.value;
}

async function serverStatus(opts) {
  const url = (opts.url !== true && opts.url) || mobileConfig().appiumUrl || DEFAULT_URL;
  try {
    const v = await http('GET', `${url}/status`);
    console.log(JSON.stringify({ running: true, url, build: v && v.build ? v.build.version : null }, null, 2));
  } catch {
    console.log(JSON.stringify({ running: false, url }, null, 2));
    process.exit(1);
  }
}

function loadSession() {
  const s = readJson(SESSION_FILE);
  if (!s || !s.sessionId) die('No exploration session - run: mobile.js session start --package <pkg> --activity <act>');
  return s;
}

const USING = {
  id: 'id',
  desc: 'accessibility id',
  xpath: 'xpath',
  uiautomator: '-android uiautomator',
  class: 'class name',
};

function locator(by, value) {
  if (by === 'text') return { using: '-android uiautomator', value: `new UiSelector().text(${JSON.stringify(value)})` };
  if (!USING[by]) die(`--by must be one of: ${[...Object.keys(USING), 'text'].join(', ')}`);
  return { using: USING[by], value };
}

async function findAll(s, opts) {
  if (!opts.by || !opts.value || opts.value === true) die('Need --by <id|desc|text|xpath|uiautomator|class> --value <value>');
  const els = await http('POST', `${s.url}/session/${s.sessionId}/elements`, locator(opts.by, String(opts.value)));
  return els.map((e) => e['element-6066-11e4-a23f-4a2c1ce6c9e6'] || e.ELEMENT);
}

async function findOne(s, opts) {
  const els = await findAll(s, opts);
  const index = Number(opts.index || 0);
  if (!els[index]) throw new Error(`No element for ${opts.by}=${opts.value}${index ? ` at index ${index}` : ''} (found ${els.length}).`);
  return els[index];
}

function decode(v) {
  return v.replace(/&#10;/g, ' ').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Turns a UiAutomator2 page source into a short, locator-oriented element list. */
function summarize(xml, pkg) {
  const rows = [];
  const re = /<([\w.$]+)\s([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = {};
    m[2].replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { attrs[k] = decode(v); return ''; });
    if (!('bounds' in attrs)) continue;
    const cls = (attrs.class || m[1]).split('.').pop();
    const interactive = ['clickable', 'checkable', 'scrollable', 'long-clickable'].some((k) => attrs[k] === 'true') || /EditText|Button|Switch|CheckBox|Spinner/.test(cls);
    const text = attrs.text || '';
    const desc = attrs['content-desc'] || '';
    const rid = attrs['resource-id'] || '';
    if (!interactive && !text && !desc) continue;
    if (attrs.displayed === 'false') continue;
    let suggested;
    if (rid) suggested = `AppiumBy.id("${rid}")`;
    else if (desc) suggested = `AppiumBy.accessibilityId("${desc}")`;
    else if (text) suggested = `AppiumBy.androidUIAutomator("new UiSelector().text(\\"${text}\\")")`;
    else suggested = `AppiumBy.xpath("//${attrs.class || m[1]}[@bounds='${attrs.bounds}']")  (fragile - no id/desc/text)`;
    const flags = ['clickable', 'checkable', 'checked', 'scrollable', 'focused', 'password', 'selected'].filter((k) => attrs[k] === 'true');
    if (attrs.enabled === 'false') flags.push('DISABLED');
    rows.push({ cls, rid: rid.replace(`${pkg}:id/`, ':id/'), text, desc, flags, bounds: attrs.bounds, suggested });
  }
  return rows;
}

async function session(sub, opts) {
  if (sub === 'start') {
    const pkg = opts.package, act = opts.activity;
    if (!pkg || pkg === true || !act || act === true) die('Usage: session start --package <pkg> --activity <act> [--udid <id>] [--url <u>] [--reset]');
    const udid = pickUdid(opts);
    const url = (opts.url !== true && opts.url) || mobileConfig().appiumUrl || DEFAULT_URL;
    const old = readJson(SESSION_FILE);
    if (old && old.sessionId) await http('DELETE', `${old.url}/session/${old.sessionId}`).catch(() => {});
    const caps = {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:udid': udid,
      'appium:appPackage': pkg,
      'appium:appActivity': fullActivity(pkg, act),
      'appium:noReset': !opts.reset,
      'appium:autoGrantPermissions': true,
      'appium:newCommandTimeout': 900,
      'appium:disableWindowAnimation': true,
    };
    const v = await http('POST', `${url}/session`, { capabilities: { alwaysMatch: caps, firstMatch: [{}] } });
    const sessionId = v.sessionId || v.sessionID;
    writeJson(SESSION_FILE, { sessionId, url, udid, package: pkg, activity: fullActivity(pkg, act), started: new Date().toISOString() });
    console.log(JSON.stringify({ sessionId, udid, package: pkg, activity: fullActivity(pkg, act) }, null, 2));
    return;
  }
  if (sub === 'status') {
    const s = readJson(SESSION_FILE);
    if (!s) return console.log('No exploration session.');
    try {
      await http('GET', `${s.url}/session/${s.sessionId}/source`);
      console.log(JSON.stringify({ alive: true, ...s }, null, 2));
    } catch {
      console.log(JSON.stringify({ alive: false, ...s }, null, 2));
      process.exit(1);
    }
    return;
  }

  const s = loadSession();
  const base = `${s.url}/session/${s.sessionId}`;
  const exec = (script, args = {}) => http('POST', `${base}/execute/sync`, { script, args: [args] });

  switch (sub) {
    case 'end':
      await http('DELETE', base).catch(() => {});
      fs.rmSync(SESSION_FILE, { force: true });
      console.log('Session ended.');
      return;
    case 'source': {
      const xml = await http('GET', `${base}/source`);
      if (opts.out && opts.out !== true) {
        fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
        fs.writeFileSync(opts.out, xml);
      }
      if (opts.raw) return console.log(xml);
      const act = await exec('mobile: getCurrentActivity').catch(() => '?');
      const pkg = await exec('mobile: getCurrentPackage').catch(() => s.package);
      const rows = summarize(xml, pkg);
      console.log(`Screen: ${pkg}/${act}  (${rows.length} elements)${pkg !== s.package ? `  !! outside the app under test (${s.package})` : ''}`);
      rows.forEach((r, i) => {
        const bits = [r.cls, r.rid && `id=${r.rid}`, r.text && `text="${r.text}"`, r.desc && `desc="${r.desc}"`, r.flags.length && `[${r.flags.join(',')}]`].filter(Boolean);
        console.log(`[${i}] ${bits.join('  ')}\n      -> ${r.suggested}`);
      });
      return;
    }
    case 'screenshot': {
      if (!opts.out || opts.out === true) die('Usage: session screenshot --out <file.png>');
      const b64 = await http('GET', `${base}/screenshot`);
      fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
      fs.writeFileSync(opts.out, Buffer.from(b64, 'base64'));
      return console.log(opts.out);
    }
    case 'activity': {
      const act = await exec('mobile: getCurrentActivity');
      const pkg = await exec('mobile: getCurrentPackage');
      return console.log(JSON.stringify({ package: pkg, activity: act }));
    }
    case 'find': {
      const els = await findAll(s, opts);
      return console.log(`${els.length} element(s) match ${opts.by}=${opts.value}`);
    }
    case 'tap': {
      const el = await findOne(s, opts);
      await http('POST', `${base}/element/${el}/click`, {});
      return console.log(`Tapped ${opts.by}=${opts.value}`);
    }
    case 'type': {
      if (opts.text === undefined || opts.text === true) die('Usage: session type --by <..> --value <v> --text <t>');
      const el = await findOne(s, opts);
      await http('POST', `${base}/element/${el}/clear`, {}).catch(() => {});
      await http('POST', `${base}/element/${el}/value`, { text: String(opts.text) });
      return console.log(`Typed into ${opts.by}=${opts.value}`);
    }
    case 'back':
      await http('POST', `${base}/back`, {});
      return console.log('Back pressed.');
    case 'hide-keyboard':
      await exec('mobile: hideKeyboard').catch(() => {});
      return console.log('Keyboard hidden (if it was shown).');
    case 'relaunch':
      await exec('mobile: terminateApp', { appId: s.package }).catch(() => {});
      await exec('mobile: startActivity', { component: `${s.package}/${s.activity}` }).catch(() => exec('mobile: activateApp', { appId: s.package }));
      return console.log(`Relaunched ${s.package}/${s.activity}`);
    case 'swipe': {
      const dir = String(opts.dir || '');
      if (!['up', 'down', 'left', 'right'].includes(dir)) die('Usage: session swipe --dir <up|down|left|right>');
      const r = await http('GET', `${base}/window/rect`);
      await exec('mobile: swipeGesture', {
        left: Math.round(r.width * 0.1), top: Math.round(r.height * 0.2),
        width: Math.round(r.width * 0.8), height: Math.round(r.height * 0.6), direction: dir, percent: 0.75,
      });
      return console.log(`Swiped ${dir}.`);
    }
    default:
      die(`Unknown session command "${sub}".`);
  }
}

// ---------------------------------------------------------------- test cases

function tcFile(id) {
  if (!id) die('Missing <APP_ID>.');
  return path.join(CWD, TC_DIR, `${id}.test-cases.json`);
}

function loadTc(id) {
  const doc = readJson(tcFile(id));
  if (!doc) die(`No test cases at ${path.relative(CWD, tcFile(id))}`);
  return doc;
}

function validateTc(doc, id) {
  const errors = [];
  if (!doc.meta || doc.meta.app_id !== id) errors.push(`meta.app_id must be "${id}".`);
  if (!Array.isArray(doc.test_cases) || !doc.test_cases.length) errors.push('test_cases must be a non-empty array.');
  const seen = new Set();
  const idRe = new RegExp(`^${id.replace(/[-]/g, '\\-')}-TC\\d{2,}$`);
  for (const tc of doc.test_cases || []) {
    const where = tc.id || '(no id)';
    if (!idRe.test(tc.id || '')) errors.push(`${where}: id must look like ${id}-TC01.`);
    if (seen.has(tc.id)) errors.push(`${where}: duplicate id.`);
    seen.add(tc.id);
    for (const k of ['title', 'screen', 'type', 'priority', 'expected_result']) if (!tc[k]) errors.push(`${where}: "${k}" is required.`);
    if (!Array.isArray(tc.steps) || !tc.steps.length) errors.push(`${where}: steps must be a non-empty array.`);
    if (tc.test_data && /password\s*[:=]\s*\S+/i.test(JSON.stringify(tc.test_data))) errors.push(`${where}: test_data looks like it holds a credential - reference an env var name instead.`);
  }
  return errors;
}

function mdEscape(v) {
  return String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function renderTc(doc) {
  const m = doc.meta;
  const a = m.approval || {};
  const lines = [
    `# ${m.app_name || m.app_id} - Mobile Test Cases`,
    '',
    '| Field | Value |', '|---|---|',
    `| App id | ${m.app_id} |`,
    `| Package / launch activity | \`${m.package}\` / \`${m.activity}\` |`,
    `| App version | ${m.app_version || ''} |`,
    `| Platform | Android (Appium + Java, UiAutomator2) |`,
    `| Document version | ${m.version || 1} |`,
    `| Generated | ${m.generated_on || ''} |`,
    `| Review | ${a.status || 'PENDING'}${a.by ? ` by ${a.by} on ${a.on}` : ''}${a.round ? ` (round ${a.round})` : ''} |`,
    '',
    '## Summary', '',
    '| TC ID | Title | Screen | Type | Priority | Automation | Test Status |', '|---|---|---|---|---|---|---|',
    ...doc.test_cases.map((t) => `| ${t.id} | ${mdEscape(t.title)} | ${mdEscape(t.screen)} | ${t.type} | ${t.priority} | ${t.automation_status || 'Not Automated'} | ${t.test_status || 'Not Run'} |`),
    '',
  ];
  for (const t of doc.test_cases) {
    lines.push(`## ${t.id} - ${t.title}${t.automation_status === 'Obsolete' ? ' (Obsolete)' : ''}`, '');
    lines.push(`**Screen:** ${t.screen} · **Type:** ${t.type} · **Priority:** ${t.priority}${t.tags && t.tags.length ? ` · **Tags:** ${t.tags.join(', ')}` : ''}`, '');
    if (t.preconditions && t.preconditions.length) lines.push('**Preconditions**', '', ...[].concat(t.preconditions).map((p) => `- ${p}`), '');
    if (t.test_data) lines.push(`**Test data:** ${typeof t.test_data === 'string' ? t.test_data : JSON.stringify(t.test_data)}`, '');
    lines.push('| # | Action | Expected |', '|---|---|---|');
    t.steps.forEach((s, i) => lines.push(`| ${s.step || i + 1} | ${mdEscape(s.action)} | ${mdEscape(s.expected)} |`));
    lines.push('', `**Expected result:** ${t.expected_result}`, '');
    if (t.automation_ref) lines.push(`**Automation:** \`${t.automation_ref}\``, '');
    if (t.execution_status) {
      lines.push(`**Last run:** ${t.execution_status} · ${t.test_status}${t.last_run ? ` · ${t.last_run}` : ''}${t.failure_category ? ` · ${t.failure_category}` : ''}`);
      if (t.actual_result) lines.push(`**Actual result:** ${t.actual_result}`);
      if (t.linked_issues && t.linked_issues.length) {
        lines.push(`**Linked issues:** ${t.linked_issues.map((i) => (/^BUG-\d+$/.test(i) ? `[${i}](../../bugs/${i}.md)` : i)).join(', ')}`);
      }
      lines.push('');
    }
  }
  if (Array.isArray(m.not_covered) && m.not_covered.length) {
    lines.push('## Not covered', '', ...m.not_covered.map((n) => `- ${n}`), '');
  }
  return lines.join('\n');
}

function testcases(sub, id, opts) {
  const file = tcFile(id);
  if (sub === 'path') return console.log(path.relative(CWD, file));
  const doc = loadTc(id);
  const save = () => {
    writeJson(file, doc);
    fs.writeFileSync(file.replace(/\.json$/, '.md'), renderTc(doc));
  };
  switch (sub) {
    case 'validate': {
      const errors = validateTc(doc, id);
      if (errors.length) { errors.forEach((e) => console.log(`ERROR ${e}`)); process.exit(1); }
      return console.log(`OK - ${doc.test_cases.length} test case(s).`);
    }
    case 'render': {
      const errors = validateTc(doc, id);
      if (errors.length) { errors.forEach((e) => console.log(`ERROR ${e}`)); process.exit(1); }
      save();
      return console.log(path.relative(CWD, file.replace(/\.json$/, '.md')));
    }
    case 'status':
      return console.log(JSON.stringify(doc.meta.approval || { status: 'PENDING' }, null, 2));
    case 'approve': {
      const prev = doc.meta.approval || {};
      doc.meta.approval = { ...prev, status: 'APPROVED', by: opts.by && opts.by !== true ? opts.by : prev.by || 'unknown', on: today(), round: prev.round || 1 };
      save();
      return console.log(`APPROVED by ${doc.meta.approval.by}`);
    }
    case 'reject': {
      if (!opts.note || opts.note === true) die('A reason is required: --note "<what is wrong and what it should say>"');
      const prev = doc.meta.approval || {};
      doc.meta.approval = { status: 'CHANGES_REQUESTED', round: (prev.round || 1) + 1, notes: [...(prev.notes || []), { on: today(), note: opts.note }] };
      save();
      return console.log(`CHANGES_REQUESTED - review round ${doc.meta.approval.round} next.`);
    }
    default:
      die(`Unknown testcases command "${sub}".`);
  }
}

// ---------------------------------------------------------------- results

function testngResults(project) {
  const file = path.join(CWD, project, 'target', 'surefire-reports', 'testng-results.xml');
  if (!fs.existsSync(file)) die(`No TestNG report at ${path.relative(CWD, file)} - run the suite first (mvn test).`);
  const xml = fs.readFileSync(file, 'utf8');
  const out = [];
  const re = /<test-method\b([^>]*?)(?:\/>|>([\s\S]*?)<\/test-method>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = {};
    m[1].replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { attrs[k] = decode(v); return ''; });
    if (attrs['is-config'] === 'true') continue;
    const body = m[2] || '';
    const exClass = (body.match(/<exception class="([^"]+)"/) || [])[1] || null;
    const message = (body.match(/<message>\s*<!\[CDATA\[([\s\S]*?)\]\]>/) || [])[1] || null;
    const tcs = `${attrs.description || ''} ${attrs.name || ''}`.match(/[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-TC\d+/g) || [];
    out.push({
      name: attrs.name, signature: attrs.signature, description: attrs.description || '', status: attrs.status,
      durationMs: Number(attrs['duration-ms']) || 0, testCases: [...new Set(tcs)],
      exception: exClass, message: message && message.trim().split('\n')[0].slice(0, 400),
    });
  }
  return { file: path.relative(CWD, file), tests: out };
}

function results(sub, id, opts, rest) {
  const project = (opts.project !== true && opts.project) || mobileConfig().projectDir || DEFAULT_PROJECT;
  if (sub === 'summary') {
    const r = testngResults(project);
    const count = (s) => r.tests.filter((t) => t.status === s).length;
    return console.log(JSON.stringify({ report: r.file, pass: count('PASS'), fail: count('FAIL'), skip: count('SKIP'), tests: r.tests }, null, 2));
  }
  const doc = loadTc(id);
  const file = tcFile(id);
  const save = () => {
    writeJson(file, doc);
    fs.writeFileSync(file.replace(/\.json$/, '.md'), renderTc(doc));
  };
  const byId = new Map(doc.test_cases.map((t) => [t.id, t]));
  if (sub === 'ingest') {
    const r = testngResults(project);
    const hits = new Map();
    for (const t of r.tests) for (const tc of t.testCases) hits.set(tc, [...(hits.get(tc) || []), t]);
    const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
    let n = 0;
    for (const tc of doc.test_cases) {
      if (tc.automation_status === 'Obsolete') continue;
      const runs = hits.get(tc.id);
      if (!runs) {
        if (tc.automation_status === 'Automated') Object.assign(tc, { execution_status: 'Not Executed', test_status: 'Not Run' });
        continue;
      }
      n++;
      const fails = runs.filter((x) => x.status === 'FAIL');
      const passes = runs.filter((x) => x.status === 'PASS');
      tc.execution_status = runs.every((x) => x.status === 'SKIP') ? 'Not Executed' : 'Executed';
      tc.last_run = now;
      tc.automation_ref = tc.automation_ref || runs[0].signature || runs[0].name;
      if (fails.length) {
        tc.test_status = 'Fail';
        tc.failure_category = null; // every new failure is re-classified by the runner
        tc.actual_result = null;
        tc.raw_error = `${fails[0].exception || ''}: ${fails[0].message || ''}`.trim();
      } else if (passes.length) {
        Object.assign(tc, { test_status: 'Pass', failure_category: null, raw_error: null, actual_result: 'Behaved as expected.' });
      } else {
        Object.assign(tc, { test_status: 'Not Run', actual_result: 'Skipped - a precondition or setup step did not complete.' });
      }
    }
    save();
    const unmatched = r.tests.filter((t) => !t.testCases.length).map((t) => t.name);
    console.log(`Ingested ${n} test case(s) from ${r.file}.`);
    if (unmatched.length) console.log(`WARN tests without a ${id}-TCnn id in their description: ${unmatched.join(', ')}`);
    return;
  }
  if (sub === 'classify') {
    const [tcId, category] = rest;
    const tc = byId.get(tcId);
    if (!tc) die(`Unknown test case ${tcId}.`);
    if (!CATEGORIES.includes(category)) die(`CATEGORY must be one of: ${CATEGORIES.join(', ')}`);
    tc.failure_category = category;
    if (opts.actual && opts.actual !== true) tc.actual_result = opts.actual;
    if (category === 'FLAKY') tc.test_status = 'Flaky';
    else if (!['APPLICATION_DEFECT', 'APP_CRASH', 'ASSERTION_FAILURE'].includes(category) && tc.test_status === 'Fail') tc.test_status = 'Blocked';
    const issues = [].concat(opts.issue || []).filter((i) => i !== true);
    tc.linked_issues = [...new Set([...(tc.linked_issues || []), ...issues])];
    save();
    return console.log(`${tcId}: ${category}${issues.length ? ` -> ${issues.join(', ')}` : ''}`);
  }
  if (sub === 'pending') {
    const problems = [];
    for (const tc of doc.test_cases) {
      if (!['Fail', 'Blocked', 'Flaky'].includes(tc.test_status)) continue;
      if (!tc.failure_category) problems.push(`${tc.id}: failure not classified`);
      if (!tc.actual_result) problems.push(`${tc.id}: no plain-language actual result`);
      if (['APPLICATION_DEFECT', 'APP_CRASH'].includes(tc.failure_category) && !(tc.linked_issues || []).length) problems.push(`${tc.id}: defect without a linked bug`);
    }
    if (problems.length) { problems.forEach((p) => console.log(p)); process.exit(1); }
    return console.log('OK');
  }
  die(`Unknown results command "${sub}".`);
}

// ---------------------------------------------------------------- main

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  const [cmd, sub, ...rest] = opts._;
  try {
    switch (cmd) {
      case 'doctor': return doctor(opts);
      case 'devices': return devices(opts);
      case 'avds': return avds();
      case 'foreground': return foreground(opts);
      case 'app': return appInfo(opts);
      case 'appid': return appid(sub);
      case 'config': return config(sub, rest);
      case 'server': return serverStatus(opts);
      case 'session': return await session(sub, opts);
      case 'testcases': return testcases(sub, rest[0], opts);
      case 'results': return results(sub, rest[0], opts, rest.slice(1));
      default: {
        const header = fs.readFileSync(__filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1];
        console.log(header.replace(/^ \* ?/gm, ''));
        process.exit(cmd ? 1 : 0);
      }
    }
  } catch (e) {
    die(`ERROR ${e.message}`);
  }
})();
