import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AppStore } from './lib/store';
import { StoreContext } from './hooks/useAppStore';
import './styles.css';

const store = new AppStore();

// E2E 테스트에서 상태를 주입/검증할 수 있도록 노출한다 (읽기·쓰기 모두 사용자 권한 범위 내).
declare global {
  interface Window {
    __worktimeStore?: AppStore;
  }
}
window.__worktimeStore = store;

const root = document.getElementById('root');
if (!root) throw new Error('#root 를 찾을 수 없습니다.');

createRoot(root).render(
  <StrictMode>
    <StoreContext.Provider value={store}>
      <App />
    </StoreContext.Provider>
  </StrictMode>,
);
