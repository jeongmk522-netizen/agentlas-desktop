// /library → 기본은 에이전트 탭으로
"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function LibraryIndex() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/library/agents");
  }, [router]);
  return null;
}
