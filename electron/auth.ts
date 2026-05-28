// agentlas.cloud 구글 로그인 — 데스크톱 패턴.
//
// 흐름:
//   1. signInWithGoogle()이 호출되면 별도 partition session의 BrowserWindow 띄움
//   2. 사용자가 그 안에서 구글 로그인 → 백엔드(POST /api/auth/google)가 agentlas_session cookie 설정
//   3. did-navigate-in-page / did-frame-finish-load 시점에 partition session.cookies에서 추출
//   4. cookie value를 macOS Keychain(keytar)에 저장
//   5. BrowserWindow 닫고 사용자 메타데이터(userId/workspaceId/email)를 main 메모리에 캐시
//
// 보안:
//   - partition은 영구가 아닌 in-memory 형태 — 윈도우가 닫히면 사라짐 (재로그인 시 새 인증)
//   - 실제 인증값은 Keychain에만. 디스크 직저장 X.
//   - signature 검증은 안 함 — 서버를 신뢰하고 cookie value를 그대로 보관/재첨부
//
// 백엔드 가정:
//   - 세션 cookie 이름: agentlas_session
//   - cookie value 포맷: base64url({ userId, workspaceId, exp }).<HMAC>
//   - 성공 redirect 형태: /account?auth=google (POST /api/auth/google 응답의 redirectTo)
//   - 사용자 메타(email, name) 조회 endpoint: /api/account/me (없으면 cookie payload만 표시)
import { BrowserWindow, session as electronSession } from "electron";
import keytar from "keytar";
import type { AuthSession } from "../shared/types";

const COOKIE_NAME = "agentlas_session";
const KEYTAR_SERVICE = "Agentlas Session";
const KEYTAR_ACCOUNT = "default";
const AUTH_PARTITION = "persist:agentlas-auth";

function webBaseUrl(): string {
  const fromEnv = process.env.AGENTLAS_WEB_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return "https://agentlas.cloud";
}

/** main 메모리에 보관하는 세션 — 디스크는 keytar만, 메타데이터는 매 부팅 시 cookie payload + me endpoint로 재구성 */
interface SessionCache {
  cookieValue: string;
  email?: string;
  name?: string;
  userId?: string;
  workspaceId?: string;
  expiresAt?: number;
}

let _cache: SessionCache | null = null;

/** cookie value의 body 부분만 base64url decode — signature 검증 안 함 (서버 신뢰). */
function decodeSessionCookie(value: string): {
  userId?: string;
  workspaceId?: string;
  expiresAt?: number;
} {
  const dot = value.indexOf(".");
  if (dot < 0) return {};
  const body = value.slice(0, dot);
  try {
    const json = Buffer.from(body, "base64url").toString("utf8");
    const obj = JSON.parse(json) as { userId?: string; workspaceId?: string; exp?: number };
    return {
      userId: obj.userId,
      workspaceId: obj.workspaceId,
      expiresAt: typeof obj.exp === "number" ? obj.exp * 1000 : undefined,
    };
  } catch {
    return {};
  }
}

/** cookie value로 백엔드 me endpoint 호출 — 없으면 조용히 null (이메일/이름 미표시 fallback) */
async function fetchAccountMeta(cookieValue: string): Promise<{ email?: string; name?: string } | null> {
  try {
    const url = `${webBaseUrl()}/api/account/me`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, {
        headers: { cookie: `${COOKIE_NAME}=${cookieValue}` },
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { email?: string; name?: string };
      return { email: json.email, name: json.name };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** 부팅 시 keytar에서 cookie를 복원 — TTL이 만료됐으면 null. */
export async function bootAuthFromKeychain(): Promise<void> {
  try {
    const stored = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
    if (!stored) return;
    const decoded = decodeSessionCookie(stored);
    if (decoded.expiresAt && decoded.expiresAt < Date.now()) {
      // 만료 — 정리하고 끝.
      await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
      return;
    }
    _cache = {
      cookieValue: stored,
      userId: decoded.userId,
      workspaceId: decoded.workspaceId,
      expiresAt: decoded.expiresAt,
    };
    // 이메일/이름은 백그라운드로 fetch (실패해도 무방)
    void fetchAccountMeta(stored).then((meta) => {
      if (!_cache || !meta) return;
      _cache = { ..._cache, email: meta.email, name: meta.name };
    });
  } catch (err) {
    console.warn("[auth] boot from keychain failed", err);
  }
}

export function getAuthSession(): AuthSession {
  if (!_cache) return { signedIn: false };
  if (_cache.expiresAt && _cache.expiresAt < Date.now()) {
    _cache = null;
    void keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
    return { signedIn: false };
  }
  return {
    signedIn: true,
    email: _cache.email,
    name: _cache.name,
    workspaceId: _cache.workspaceId,
    expiresAt: _cache.expiresAt,
  };
}

/** 마켓플레이스 fetch에 첨부할 cookie 헤더 값 — 미로그인이면 null. */
export function getSessionCookieHeader(): string | null {
  if (!_cache) return null;
  if (_cache.expiresAt && _cache.expiresAt < Date.now()) return null;
  return `${COOKIE_NAME}=${_cache.cookieValue}`;
}

export async function signInWithGoogle(parent: BrowserWindow | null): Promise<AuthSession> {
  const ses = electronSession.fromPartition(AUTH_PARTITION);
  // 로그인 창은 시스템 BrowserWindow — 별도 partition으로 격리해 메인 앱의 쿠키와 섞이지 않음
  const win = new BrowserWindow({
    width: 480,
    height: 720,
    parent: parent ?? undefined,
    modal: !!parent,
    title: "Agentlas — 로그인",
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const loginUrl = `${webBaseUrl()}/account?desktop=1`;

  return new Promise<AuthSession>((resolve, reject) => {
    let settled = false;

    async function maybeFinish() {
      if (settled) return;
      // cookie를 partition session에서 추출
      const cookies = await ses.cookies.get({ name: COOKIE_NAME });
      if (cookies.length === 0) return;
      // 가장 fresh한 cookie 선택 — expirationDate가 큰 것
      cookies.sort((a, b) => (b.expirationDate ?? 0) - (a.expirationDate ?? 0));
      const cookie = cookies[0];
      const value = cookie.value;
      settled = true;
      try {
        await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, value);
      } catch (err) {
        console.warn("[auth] keytar set failed — keeping session in memory only", err);
      }
      const decoded = decodeSessionCookie(value);
      _cache = {
        cookieValue: value,
        userId: decoded.userId,
        workspaceId: decoded.workspaceId,
        expiresAt: decoded.expiresAt,
      };
      // 메타 채우기 — 실패해도 resolve는 진행
      const meta = await fetchAccountMeta(value);
      if (meta && _cache) {
        _cache = { ..._cache, email: meta.email, name: meta.name };
      }
      try {
        win.close();
      } catch {
        // ignore
      }
      resolve(getAuthSession());
    }

    // 사용자가 그냥 창을 닫으면 reject
    win.on("closed", () => {
      if (!settled) {
        settled = true;
        resolve({ signedIn: false });
      }
    });

    win.webContents.on("did-finish-load", () => {
      void maybeFinish();
    });
    win.webContents.on("did-navigate", () => {
      void maybeFinish();
    });
    win.webContents.on("did-navigate-in-page", () => {
      void maybeFinish();
    });

    win.loadURL(loginUrl).catch((err) => {
      if (settled) return;
      settled = true;
      try {
        win.close();
      } catch {
        // ignore
      }
      reject(err);
    });
  });
}

export async function signOut(): Promise<void> {
  _cache = null;
  try {
    await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
  } catch (err) {
    console.warn("[auth] keytar delete failed", err);
  }
  // 로그인 partition의 쿠키도 모두 비움 — 다음 signIn 시 깨끗한 상태에서 시작
  try {
    const ses = electronSession.fromPartition(AUTH_PARTITION);
    await ses.clearStorageData({ storages: ["cookies", "localstorage"] });
  } catch (err) {
    console.warn("[auth] clearStorageData failed", err);
  }
}
