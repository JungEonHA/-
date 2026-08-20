import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AppStore } from './lib/store';
import { StoreContext } from './hooks/useAppStore';
import { parseBootParams, urlWithoutSecrets } from './lib/bootParams';
import { BUILD_ID } from './lib/build';
import './styles.css';

const boot = parseBootParams(window.location.search);

// URL 이 사람을 지정하면 그 사람 전용 저장 칸을 쓴다.
//
// 같은 Notion 페이지의 위젯 두 개는 브라우저가 보기에 같은 저장소를 공유한다.
// 칸을 가르지 않으면 두 위젯이 서로의 이름과 기록을 덮어쓴다 — 실제로 그랬다.
const store = new AppStore(undefined, undefined, boot.employeeName);
// URL 이 지정한 직원/접근 키를 먼저 반영한 뒤 그린다 — 위젯이 잠깐이라도
// 다른 사람 기록을 보여주는 일이 없도록.
store.applyBootParams(boot);

if (boot.theme) document.documentElement.dataset.theme = boot.theme;
if (boot.widget) document.documentElement.dataset.view = 'widget';

// 반영이 끝났으면 접근 키는 주소에서 지운다 (히스토리·복사 노출 방지).
// Notion 블록에 저장된 원래 URL 은 그대로라 새로고침하면 다시 적용된다.
const cleanedUrl = urlWithoutSecrets(window.location.href);
if (cleanedUrl) window.history.replaceState(null, '', cleanedUrl);

// E2E 테스트에서 상태를 주입/검증할 수 있도록 노출한다 (읽기·쓰기 모두 사용자 권한 범위 내).
declare global {
  interface Window {
    __worktimeStore?: AppStore;
    /** 이 화면이 돌리는 코드의 커밋. 위젯이 낡았는지 밖에서 물어볼 수 있어야 한다. */
    __worktimeBuild?: string;
  }
}
window.__worktimeStore = store;
window.__worktimeBuild = BUILD_ID;

const root = document.getElementById('root');
if (!root) throw new Error('#root 를 찾을 수 없습니다.');

createRoot(root).render(
  <StrictMode>
    <StoreContext.Provider value={store}>
      <App widget={boot.widget} />
    </StoreContext.Provider>
  </StrictMode>,
);
