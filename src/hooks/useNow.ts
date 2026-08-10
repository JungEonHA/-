import { useEffect, useState } from 'react';

/**
 * 현재 시각(epoch ms)을 주기적으로 갱신해 리렌더를 유발한다.
 *
 * 중요: 이 훅은 **시간을 세지 않는다**. 단지 "다시 그릴 때가 됐다"고 알릴 뿐이고,
 * 실제 값은 항상 Date.now() 다. 따라서 탭이 백그라운드로 내려가 타이머가
 * throttling 되거나, 컴퓨터가 절전에 들어가 인터벌이 아예 멈춰도
 * 화면이 다시 그려지는 순간 정확한 시각이 반영된다.
 *
 * 추가로 visibilitychange / focus / pageshow / online 이벤트에서 즉시 갱신해,
 * 절전에서 깨어나거나 탭으로 돌아온 직후의 "멈춘 것처럼 보이는" 구간을 없앤다.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = () => {
      setNow(Date.now());
      // 초 경계에 맞춰 다음 틱을 예약한다 (드리프트 누적 없이 깔끔한 초 단위 갱신).
      const delay =
        intervalMs === 1000 ? 1000 - (Date.now() % 1000) || 1000 : intervalMs;
      timer = setTimeout(tick, delay);
    };

    const resync = () => {
      setNow(Date.now());
      if (timer !== undefined) clearTimeout(timer);
      tick();
    };

    tick();

    const onVisibility = () => {
      if (document.visibilityState === 'visible') resync();
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', resync);
    window.addEventListener('pageshow', resync);
    window.addEventListener('online', resync);

    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', resync);
      window.removeEventListener('pageshow', resync);
      window.removeEventListener('online', resync);
    };
  }, [intervalMs]);

  return now;
}
