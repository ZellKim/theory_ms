import { useState, useCallback, useRef } from "react";

const GITHUB_URL = "https://zellkim.github.io/theory_ms/";

function extractData(html) {
  const dataMatch = html.match(/var DATA=(\{.*?\});/s);
  if (!dataMatch) return null;
  const data = JSON.parse(dataMatch[1]);

  const proofs = [];
  const proofMatches = [...html.matchAll(/var (PROOF\d*)=(\[.*?\]);/gs)];
  for (const m of proofMatches) {
    const pnum = m[1].replace("PROOF", "") || "1";
    const steps = JSON.parse(m[2]);
    proofs.push({ num: pnum, steps });
  }

  return { data, proofs };
}

function extractRefs(parsed) {
  const { data, proofs } = parsed;
  const titles = {};
  for (const key of ["A", "P", "D", "O", "L", "T", "C", "S"]) {
    for (const item of data[key] || []) {
      titles[item.id] = item.title;
    }
  }

  const refs = [];
  const allBodies = [];

  for (const key of ["L", "T", "C", "S", "O"]) {
    for (const item of data[key] || []) {
      allBodies.push({ loc: item.id, body: item.body || "" });
    }
  }
  for (const p of proofs) {
    for (const step of p.steps) {
      allBodies.push({
        loc: `P${p.num}.${(step.title || "").slice(0, 20)}`,
        body: (step.body || "") + " " + (step.title || ""),
      });
    }
  }

  for (const { loc, body } of allBodies) {
    const regex = /\b([LT]\d+)\(([^)]+)\)/g;
    let m;
    while ((m = regex.exec(body)) !== null) {
      const ref = m[1];
      const hint = m[2];
      const actualTitle = titles[ref] || "???미존재";
      const start = Math.max(0, m.index - 40);
      const end = Math.min(body.length, m.index + m[0].length + 40);
      const context = body.slice(start, end).replace(/\n/g, " ");

      refs.push({ loc, ref, hint, actualTitle, context });
    }
  }

  return { refs, titles };
}

function batchRefs(refs, size = 8) {
  const batches = [];
  for (let i = 0; i < refs.length; i += size) {
    batches.push(refs.slice(i, i + size));
  }
  return batches;
}

async function verifyBatch(batch) {
  const items = batch
    .map(
      (r, i) =>
        `[${i + 1}] 위치: ${r.loc}\n참조: ${r.ref}(${r.hint})\n${r.ref} 실제 제목: "${r.actualTitle}"\n맥락: "${r.context}"`
    )
    .join("\n\n");

  const prompt = `당신은 철학 공리체계 De Natura Hominis et Felicitatis의 참조 정합성 검증자입니다.

아래 참조들이 맥락에서 올바른지 판단하세요. 각 항목에 대해:
- 맥락에서 이 참조가 의도하는 내용과 실제 제목이 의미적으로 일치하면 OK
- 일치하지 않으면 MISMATCH와 이유, 그리고 올바른 참조가 무엇일지 추측

반드시 JSON 배열로만 응답하세요. 다른 텍스트 없이.
[{"index":1,"status":"OK"}, {"index":2,"status":"MISMATCH","reason":"맥락은 소진 구조인데 실제는 용서","suggestion":"L23(원하는것→소진)"}]

${items}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  const text = data.content
    .map((c) => c.text || "")
    .filter(Boolean)
    .join("");
  
  try {
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return batch.map((_, i) => ({ index: i + 1, status: "ERROR", reason: "파싱 실패" }));
  }
}

export default function RefValidator() {
  const [status, setStatus] = useState("idle");
  const [refs, setRefs] = useState([]);
  const [results, setResults] = useState([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [error, setError] = useState(null);
  const abortRef = useRef(false);

  const loadData = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const res = await fetch(GITHUB_URL);
      const html = await res.text();
      const parsed = extractData(html);
      if (!parsed) throw new Error("DATA 추출 실패");
      const { refs: extracted } = extractRefs(parsed);
      setRefs(extracted);
      setStatus("ready");
    } catch (e) {
      setError(e.message);
      setStatus("idle");
    }
  }, []);

  const verify = useCallback(async () => {
    setStatus("verifying");
    abortRef.current = false;
    const batches = batchRefs(refs, 8);
    setProgress({ current: 0, total: batches.length });
    const allResults = [];

    for (let i = 0; i < batches.length; i++) {
      if (abortRef.current) break;
      try {
        const batchResults = await verifyBatch(batches[i]);
        for (let j = 0; j < batches[i].length; j++) {
          const r = batchResults.find((br) => br.index === j + 1) || {
            status: "ERROR",
            reason: "결과 없음",
          };
          allResults.push({ ...batches[i][j], ...r });
        }
      } catch (e) {
        for (const ref of batches[i]) {
          allResults.push({ ...ref, status: "ERROR", reason: e.message });
        }
      }
      setProgress({ current: i + 1, total: batches.length });
      setResults([...allResults]);
    }

    setStatus("done");
  }, [refs]);

  const mismatches = results.filter((r) => r.status === "MISMATCH");
  const errors = results.filter((r) => r.status === "ERROR");
  const oks = results.filter((r) => r.status === "OK");

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0a0a",
        color: "#d4cfc8",
        fontFamily: "'Noto Sans KR', 'Pretendard', sans-serif",
        padding: "24px 16px",
        maxWidth: 720,
        margin: "0 auto",
      }}
    >
      <h1
        style={{
          fontSize: 18,
          fontWeight: 400,
          letterSpacing: "0.08em",
          color: "#8a7d6f",
          marginBottom: 4,
          textAlign: "center",
        }}
      >
        De Natura Hominis
      </h1>
      <h2
        style={{
          fontSize: 13,
          fontWeight: 400,
          color: "#4a4540",
          letterSpacing: "0.15em",
          textAlign: "center",
          marginBottom: 32,
        }}
      >
        REFERENCE INTEGRITY VALIDATOR
      </h2>

      {/* Step 1: Load */}
      <div
        style={{
          background: "#111",
          border: "1px solid #1e1e1e",
          borderRadius: 10,
          padding: "20px 24px",
          marginBottom: 16,
        }}
      >
        <div
          style={{
            fontSize: 10,
            color: "#555",
            letterSpacing: "0.12em",
            marginBottom: 10,
          }}
        >
          STEP 1 — DATA LOAD
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            onClick={loadData}
            disabled={status === "loading" || status === "verifying"}
            style={{
              padding: "8px 20px",
              borderRadius: 6,
              border: "1px solid #2a2520",
              background: status === "ready" || status === "done" ? "#1a1a1a" : "#1c1810",
              color: status === "ready" || status === "done" ? "#555" : "#b8a88a",
              fontSize: 12,
              letterSpacing: "0.05em",
              cursor: status === "loading" || status === "verifying" ? "not-allowed" : "pointer",
              opacity: status === "loading" ? 0.5 : 1,
            }}
          >
            {status === "loading"
              ? "로딩 중..."
              : refs.length > 0
              ? `✓ ${refs.length}개 참조 로드됨`
              : "GitHub에서 불러오기"}
          </button>
        </div>
        {error && (
          <div style={{ color: "#c44", fontSize: 11, marginTop: 8 }}>
            {error}
          </div>
        )}
      </div>

      {/* Step 2: Verify */}
      {refs.length > 0 && (
        <div
          style={{
            background: "#111",
            border: "1px solid #1e1e1e",
            borderRadius: 10,
            padding: "20px 24px",
            marginBottom: 16,
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: "#555",
              letterSpacing: "0.12em",
              marginBottom: 10,
            }}
          >
            STEP 2 — LLM SEMANTIC VERIFICATION
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              onClick={verify}
              disabled={status === "verifying"}
              style={{
                padding: "8px 20px",
                borderRadius: 6,
                border: "1px solid #2a2520",
                background: status === "done" ? "#1a1a1a" : "#1c1810",
                color: status === "done" ? "#555" : "#b8a88a",
                fontSize: 12,
                letterSpacing: "0.05em",
                cursor: status === "verifying" ? "not-allowed" : "pointer",
              }}
            >
              {status === "verifying"
                ? `검증 중... (${progress.current}/${progress.total})`
                : status === "done"
                ? "재검증"
                : `${refs.length}개 참조 검증 시작`}
            </button>
            {status === "verifying" && (
              <button
                onClick={() => (abortRef.current = true)}
                style={{
                  padding: "8px 14px",
                  borderRadius: 6,
                  border: "1px solid #331a1a",
                  background: "#1a1010",
                  color: "#c66",
                  fontSize: 11,
                }}
              >
                중단
              </button>
            )}
          </div>
          {status === "verifying" && (
            <div style={{ marginTop: 12 }}>
              <div
                style={{
                  height: 3,
                  background: "#1a1a1a",
                  borderRadius: 2,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${(progress.current / progress.total) * 100}%`,
                    background: "#8a7d6f",
                    borderRadius: 2,
                    transition: "width 0.3s",
                  }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Results Summary */}
      {results.length > 0 && (
        <div
          style={{
            background: "#111",
            border: "1px solid #1e1e1e",
            borderRadius: 10,
            padding: "20px 24px",
            marginBottom: 16,
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: "#555",
              letterSpacing: "0.12em",
              marginBottom: 14,
            }}
          >
            RESULTS
          </div>
          <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
            <div
              style={{
                flex: 1,
                background: "#0d1a0d",
                border: "1px solid #1a2e1a",
                borderRadius: 8,
                padding: "12px 16px",
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: 24, color: "#5a8a5a", fontWeight: 300 }}>
                {oks.length}
              </div>
              <div style={{ fontSize: 10, color: "#3a5a3a", letterSpacing: "0.1em" }}>
                OK
              </div>
            </div>
            <div
              style={{
                flex: 1,
                background: mismatches.length > 0 ? "#1a0d0d" : "#111",
                border: `1px solid ${mismatches.length > 0 ? "#2e1a1a" : "#1e1e1e"}`,
                borderRadius: 8,
                padding: "12px 16px",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  fontSize: 24,
                  color: mismatches.length > 0 ? "#c45" : "#555",
                  fontWeight: 300,
                }}
              >
                {mismatches.length}
              </div>
              <div style={{ fontSize: 10, color: mismatches.length > 0 ? "#8a3a3a" : "#444", letterSpacing: "0.1em" }}>
                MISMATCH
              </div>
            </div>
            <div
              style={{
                flex: 1,
                background: "#111",
                border: "1px solid #1e1e1e",
                borderRadius: 8,
                padding: "12px 16px",
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: 24, color: "#555", fontWeight: 300 }}>
                {errors.length}
              </div>
              <div style={{ fontSize: 10, color: "#444", letterSpacing: "0.1em" }}>
                ERROR
              </div>
            </div>
          </div>

          {/* Mismatch Details */}
          {mismatches.length > 0 && (
            <div>
              <div
                style={{
                  fontSize: 11,
                  color: "#c45",
                  letterSpacing: "0.08em",
                  marginBottom: 10,
                  borderBottom: "1px solid #2e1a1a",
                  paddingBottom: 6,
                }}
              >
                MISMATCHES
              </div>
              {mismatches.map((r, i) => (
                <div
                  key={i}
                  style={{
                    background: "#130a0a",
                    border: "1px solid #251515",
                    borderRadius: 8,
                    padding: "14px 16px",
                    marginBottom: 8,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: "#c45", fontFamily: "monospace" }}>
                      {r.loc}
                    </span>
                    <span style={{ fontSize: 10, color: "#8a4a4a" }}>
                      {r.ref}({r.hint})
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: "#886", marginBottom: 4 }}>
                    실제: {r.actualTitle?.slice(0, 45)}
                  </div>
                  <div style={{ fontSize: 11, color: "#a66", marginBottom: 4 }}>
                    {r.reason}
                  </div>
                  {r.suggestion && (
                    <div
                      style={{
                        fontSize: 11,
                        color: "#5a8a5a",
                        background: "#0a130a",
                        padding: "6px 10px",
                        borderRadius: 4,
                        marginTop: 4,
                      }}
                    >
                      제안: {r.suggestion}
                    </div>
                  )}
                  <div
                    style={{
                      fontSize: 10,
                      color: "#443",
                      marginTop: 6,
                      fontStyle: "italic",
                    }}
                  >
                    "{r.context?.slice(0, 80)}"
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* OK list (collapsed) */}
          {oks.length > 0 && (
            <details style={{ marginTop: 12 }}>
              <summary
                style={{
                  fontSize: 11,
                  color: "#5a8a5a",
                  cursor: "pointer",
                  letterSpacing: "0.08em",
                  paddingBottom: 6,
                  borderBottom: "1px solid #1a2e1a",
                }}
              >
                OK ({oks.length}건) — 클릭하여 펼치기
              </summary>
              <div style={{ marginTop: 8 }}>
                {oks.map((r, i) => (
                  <div
                    key={i}
                    style={{
                      fontSize: 10,
                      color: "#3a5a3a",
                      padding: "4px 8px",
                      borderBottom: "1px solid #111",
                    }}
                  >
                    <span style={{ color: "#5a8a5a", fontFamily: "monospace", marginRight: 8 }}>
                      {r.loc}
                    </span>
                    {r.ref}({r.hint})
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      <div
        style={{
          fontSize: 9,
          color: "#2a2a2a",
          textAlign: "center",
          marginTop: 24,
          letterSpacing: "0.1em",
        }}
      >
        Claude Sonnet 4 기반 의미 비교 · 참조당 ~0.001$ · 배치 단위 8개
      </div>
    </div>
  );
}
