// firm/agents 화면의 레포 패널이 선택한 폴더를 localStorage에 기억하는 어댑터.
// 채팅과 달리 이 화면들엔 working_folder(SQLite) 개념이 없어 클라이언트에 저장한다.
// (폴더 경로만 저장 — 파일 내용/시크릿은 저장하지 않음.)
export function localFolderPersistence(scopeKey: string): {
  load: () => Promise<string | null>;
  save: (path: string | null) => Promise<void>;
} {
  const storageKey = `agentlas.repo.${scopeKey}`;
  return {
    load: async () => {
      try {
        return window.localStorage.getItem(storageKey);
      } catch {
        return null;
      }
    },
    save: async (path: string | null) => {
      try {
        if (path) window.localStorage.setItem(storageKey, path);
        else window.localStorage.removeItem(storageKey);
      } catch {
        // ignore
      }
    },
  };
}
