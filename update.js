import { savedFolder, verifyInstalledFolder, downloadUpdate, applyFiles } from './lib/folder-update.js';

const choose = document.getElementById('choose');
const install = document.getElementById('install');
const folder = document.getElementById('folder');
const status = document.getElementById('status');
const updating = new URLSearchParams(location.search).get('action') === 'install';
let directory;
let busy = false;
function message(text) { status.textContent = text; }
function controls(value) {
  busy = value;
  choose.disabled = value;
  install.disabled = value || !directory;
  install.hidden = !updating || !directory;
}
function showFolder() {
  folder.textContent = directory ? `저장된 폴더: ${directory.name}` : '선택한 폴더가 없어요.';
}
document.getElementById('title').textContent = updating ? '확장 업데이트' : '폴더 설정';
document.title = updating ? 'gw-worktime 업데이트' : 'gw-worktime 폴더 설정';
document.getElementById('hint').textContent = updating
  ? '선택한 설치 폴더에 새 버전을 다운로드하고 적용한 뒤 자동으로 다시 로드합니다. 작업 중에는 이 탭과 브라우저를 닫지 마세요.'
  : '여기서는 폴더만 저장합니다. 새 버전이 나오면 기존 설정 화면의 업데이트 버튼이나 업데이트 알림을 눌러 적용하세요.';
choose.textContent = updating ? '설치 폴더 지정하고 업데이트' : '설치 폴더 선택';
window.addEventListener('beforeunload', event => {
  if (busy) { event.preventDefault(); event.returnValue = ''; }
});

async function performUpdate(requestPermission = false) {
  controls(true);
  message('폴더 권한과 설치 위치를 확인하는 중…');
  try {
    // Only the explicit permission button requests a prompt, directly from its click.
    const permission = requestPermission
      ? await directory.requestPermission({ mode: 'readwrite' })
      : await directory.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') {
      install.textContent = '권한 허용하고 업데이트';
      message('저장된 폴더의 쓰기 권한을 허용하면 업데이트를 이어갑니다.');
      return;
    }
    await navigator.locks.request('gw-worktime-folder-update', { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('다른 탭에서 업데이트 중이에요.');
      await verifyInstalledFolder(directory);
      const update = await downloadUpdate(chrome.runtime.getManifest(), fetch, message);
      await applyFiles(directory, update.files, message);
      message(`v${update.version} 적용 완료. 확장을 다시 로드합니다.`);
      busy = false;
      chrome.runtime.reload();
    });
  } catch (error) { message(error.message); install.textContent = '업데이트 다시 시도'; }
  finally { controls(false); }
}

choose.addEventListener('click', async () => {
  controls(true);
  let selected;
  try {
    selected = await window.showDirectoryPicker({ id: 'extension-install', mode: 'readwrite' });
    await verifyInstalledFolder(selected);
    await savedFolder(selected);
    directory = selected;
    showFolder();
    message('폴더를 저장했어요.');
  } catch (error) {
    message(error.name === 'AbortError' ? '폴더 선택을 취소했어요.' : `폴더를 저장하지 못했어요. ${error.message}`);
    return;
  } finally { controls(false); }
  if (updating) await performUpdate();
});
install.addEventListener('click', () => performUpdate(true));

try {
  if (!window.showDirectoryPicker) throw new Error('이 브라우저에서는 폴더 설정을 지원하지 않아요.');
  directory = await savedFolder();
  showFolder();
  controls(false);
  if (updating && directory) await performUpdate();
  else if (updating) message('업데이트할 설치 폴더를 먼저 지정해 주세요. 지정하면 업데이트가 이어집니다.');
} catch (error) { folder.textContent = '폴더를 불러오지 못했어요.'; message(error.message); choose.disabled = !window.showDirectoryPicker; }
