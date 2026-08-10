import { createContext, useContext, useSyncExternalStore } from 'react';
import type { AppStore, Snapshot } from '../lib/store';

export const StoreContext = createContext<AppStore | null>(null);

export function useStore(): AppStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('StoreContext 가 제공되지 않았습니다.');
  return store;
}

export function useSnapshot(): Snapshot {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
