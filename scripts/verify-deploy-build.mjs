/**
 * 배포 형태 그대로 빌드를 재현해 검증한다.
 *
 * 왜 필요한가:
 *   Vercel 은 .vercelignore 로 걸러진 파일만 업로드한 뒤 `npm run build` 를 돌린다.
 *   전체 체크아웃 상태인 로컬/CI 에서는 모든 파일이 있으므로 빌드가 통과하지만,
 *   배포 환경에서는 "업로드되지 않은 파일"을 참조하다 TS2307 로 깨질 수 있다.
 *   실제로 그렇게 배포가 실패했다. 이 스크립트는 그 조건을 그대로 복제한다.
 *
 * 동작:
 *   git 추적 파일 중 .vercelignore 에 걸리지 않는 것만 임시 디렉터리로 복사하고,
 *   node_modules 만 심볼릭 링크한 뒤 그 안에서 `npm run build` 를 실행한다.
 *
 * 사용법: npm run verify:deploy
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

// ---------------------------------------------------------------------------
// .vercelignore 매처 (gitignore 문법 중 이 프로젝트가 쓰는 부분만)
// ---------------------------------------------------------------------------

function readPatterns() {
  return readFileSync(join(root, '.vercelignore'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

const REGEX_SPECIALS = '.+^${}()|[]\\';

/** 글롭 패턴을 정규식 본문으로 바꾼다. 한 글자씩 훑어서 이스케이프 순서 문제를 피한다. */
function globToRegExpBody(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?'; // `**/` — 임의 깊이 (0단계 포함)
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*'; // `*` — 슬래시를 넘지 않는다
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (REGEX_SPECIALS.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return out;
}

function toMatcher(pattern) {
  // 디렉터리 지정: 그 아래 전부 제외
  if (pattern.endsWith('/')) {
    const dir = pattern.slice(0, -1);
    return (path) => path === dir || path.startsWith(`${dir}/`);
  }

  const glob = globToRegExpBody(pattern);
  // 슬래시가 없으면 gitignore 처럼 어느 깊이에서든 파일명으로 매칭한다
  const body = pattern.includes('/') ? glob : `(?:.*/)?${glob}`;
  const exact = new RegExp(`^${body}$`);
  const asDir = new RegExp(`^${body}/`); // 매칭 대상이 디렉터리면 하위도 제외
  return (path) => exact.test(path) || asDir.test(path);
}

// ---------------------------------------------------------------------------

function main() {
  const matchers = readPatterns().map(toMatcher);

  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);

  const kept = [];
  const dropped = [];
  for (const f of tracked) (matchers.some((m) => m(f)) ? dropped : kept).push(f);

  console.log(`추적 파일 ${tracked.length}개 → 업로드 ${kept.length}개 / 제외 ${dropped.length}개`);
  console.log('제외됨:');
  for (const f of dropped) console.log(`  - ${f}`);

  const stage = mkdtempSync(join(tmpdir(), 'deploy-verify-'));
  let failed = false;
  try {
    for (const f of kept) {
      const dest = join(stage, f);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(root, f), dest);
    }
    // 설치를 다시 하지 않기 위해 의존성만 링크한다 (업로드 대상이 아니다)
    symlinkSync(join(root, 'node_modules'), join(stage, 'node_modules'), 'dir');

    console.log(`\n임시 디렉터리에서 빌드: ${stage}\n`);
    execFileSync('npm', ['run', 'build'], { cwd: stage, stdio: 'inherit' });
    console.log('\n✔ 배포 형태 빌드 성공 — Vercel 에서도 같은 결과가 나온다.');
  } catch (err) {
    failed = true;
    console.error(`\n✖ 배포 형태 빌드 실패: ${err.message}`);
    console.error(
      '  .vercelignore 로 제외된 파일을 tsconfig.build.json 이 참조하고 있지 않은지 확인하세요.',
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }

  process.exitCode = failed ? 1 : 0;
}

main();
