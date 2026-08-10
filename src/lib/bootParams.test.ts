import { describe, expect, it } from 'vitest';
import { fullViewUrl, parseBootParams, urlWithoutSecrets } from './bootParams';

describe('parseBootParams', () => {
  it('파라미터가 없으면 전체 화면이다', () => {
    const p = parseBootParams('');
    expect(p.widget).toBe(false);
    expect(p.employeeName).toBeNull();
    expect(p.accessKey).toBeNull();
    expect(p.theme).toBeNull();
  });

  it('embed / widget / view 중 무엇으로 써도 위젯이 된다', () => {
    expect(parseBootParams('?embed=1').widget).toBe(true);
    expect(parseBootParams('?embed').widget).toBe(true);
    expect(parseBootParams('?widget=true').widget).toBe(true);
    expect(parseBootParams('?view=widget').widget).toBe(true);
  });

  it('전체 화면을 뜻하는 값은 위젯으로 보지 않는다', () => {
    for (const v of ['0', 'false', 'no', 'off', 'full', 'app', 'FULL']) {
      expect(parseBootParams(`?embed=${v}`).widget).toBe(false);
    }
  });

  it('직원 이름과 접근 키를 읽고 공백을 다듬는다', () => {
    const p = parseBootParams('?employee=%20%EB%B0%95%EC%A7%84%EA%B7%9C%20&key=%20s3cret%20');
    expect(p.employeeName).toBe('박진규');
    expect(p.accessKey).toBe('s3cret');
  });

  it('빈 값은 "지정하지 않음"으로 본다 — 저장된 설정을 지우지 않는다', () => {
    const p = parseBootParams('?employee=&key=');
    expect(p.employeeName).toBeNull();
    expect(p.accessKey).toBeNull();
  });

  it('theme 은 light/dark 만 받아들인다', () => {
    expect(parseBootParams('?theme=dark').theme).toBe('dark');
    expect(parseBootParams('?theme=LIGHT').theme).toBe('light');
    expect(parseBootParams('?theme=purple').theme).toBeNull();
  });

  it('백엔드 주소는 URL 로 바꿀 수 없다 — 접근 키를 남의 서버로 보내는 링크 방지', () => {
    const p = parseBootParams('?api=https://evil.example.com&apiBase=https://evil.example.com');
    expect(p).not.toHaveProperty('apiBase');
    expect(Object.values(p)).not.toContain('https://evil.example.com');
  });
});

describe('urlWithoutSecrets', () => {
  it('접근 키만 지우고 나머지는 남긴다', () => {
    const out = urlWithoutSecrets('https://app.example.com/?embed=1&employee=%EB%B0%95&key=s3cret');
    expect(out).not.toBeNull();
    const url = new URL(out!);
    expect(url.searchParams.get('key')).toBeNull();
    expect(url.searchParams.get('embed')).toBe('1');
    expect(url.searchParams.get('employee')).toBe('박');
  });

  it('대소문자/변형 표기의 키도 지운다', () => {
    const out = urlWithoutSecrets('https://a.example.com/?Key=1&accessKey=2&access_key=3&x=4');
    const url = new URL(out!);
    expect([...url.searchParams.keys()]).toEqual(['x']);
  });

  it('지울 것이 없으면 null 을 돌려준다 (히스토리를 건드리지 않기 위해)', () => {
    expect(urlWithoutSecrets('https://a.example.com/?embed=1')).toBeNull();
  });
});

describe('fullViewUrl', () => {
  it('직원 이름은 넘기고 접근 키는 넘기지 않는다', () => {
    expect(fullViewUrl('https://a.example.com', '/', '박진규')).toBe(
      'https://a.example.com/?employee=%EB%B0%95%EC%A7%84%EA%B7%9C',
    );
  });

  it('이름이 없으면 쿼리를 붙이지 않는다', () => {
    expect(fullViewUrl('https://a.example.com', '/', '  ')).toBe('https://a.example.com/');
  });
});
