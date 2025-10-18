import { useState, useRef, useEffect } from "react";
import "./App.css";
import { marked } from "marked";
import hljs from "highlight.js";
import "highlight.js/styles/github-dark.css";

marked.setOptions({
  breaks: true,
  gfm: true,
  highlight: (code, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  },
});

export default function App() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]); // { role: "user" | "assistant", content: string }
  const [loading, setLoading] = useState(false);
  const chatRef = useRef(null);

  useEffect(() => {
    chatRef.current?.scrollTo(0, chatRef.current.scrollHeight);
  }, [messages]);

  const callStreamApi = async () => {
    if (!input.trim()) return;

    // push user message
    setMessages(prev => [...prev, { role: "user", content: input }]);
    const userInput = input;
    setInput("");
    setLoading(true);

    // push a single assistant placeholder (only once)
    setMessages(prev => [...prev, { role: "assistant", content: "" }]);

    const res = await fetch("http://localhost:8080/conversations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify({ message: userInput }),
    });

    if (!res.ok || !res.body) {
      console.error("Failed to open stream:", res.status, res.statusText);
      setLoading(false);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");

    let buffer = ""; // keep trailing partial line between reads

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // decode current chunk and append to buffer
        buffer += decoder.decode(value, { stream: true });

        // extract full lines
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1); // remaining buffer

          if (!line) continue;

          // typical SSE line looks like: data: {...}
          if (!line.startsWith("data:")) continue;

          const data = line.replace(/^data:\s*/, "");
          if (!data || data === "[DONE]") continue;

          // parse safely
          let json;
          try {
            json = JSON.parse(data);
          } catch (err) {
            // If parsing fails, skip this line (it might be partial; but because we extracted only full lines,
            // a parse error likely means server sent malformed JSON — skip).
            console.warn("Failed to JSON.parse SSE data line:", data);
            continue;
          }

          // guard for optional fields
          if (json?.metadata?.finishReason === "STOP") {
            continue;
          }

          // extract delta content (support multiple field names)
          const delta = json.text ?? json.delta ?? json.content ?? "";

          if (delta) {
            // update the last assistant message immutably and reliably
            setMessages(prev => {
              if (prev.length === 0) {
                // if somehow no messages exist, create assistant message
                return [{ role: "assistant", content: delta }];
              }
              // copy existing messages, update last message's content
              const copy = prev.slice();
              const lastIndex = copy.length - 1;
              const last = copy[lastIndex];

              // if last is not an assistant (shouldn't normally happen), append a new assistant
              if (!last || last.role !== "assistant") {
                copy.push({ role: "assistant", content: delta });
              } else {
                copy[lastIndex] = { ...last, content: last.content + delta };
              }
              return copy;
            });
          }
        }

        // loop continues: leftover partial line remains in buffer
      }

      // after stream completes, there may be a remaining buffer that doesn't end with newline
      if (buffer.trim()) {
        const leftover = buffer.trim();
        // try parse leftover if it looks like data:
        if (leftover.startsWith("data:")) {
          const data = leftover.replace(/^data:\s*/, "");
          if (data !== "[DONE]") {
            try {
              const json = JSON.parse(data);
              const delta = json.text ?? json.delta ?? json.content ?? "";
              if (delta) {
                setMessages(prev => {
                  if (prev.length === 0) return [{ role: "assistant", content: delta }];
                  const copy = prev.slice();
                  const lastIndex = copy.length - 1;
                  const last = copy[lastIndex];
                  if (!last || last.role !== "assistant") {
                    copy.push({ role: "assistant", content: delta });
                  } else {
                    copy[lastIndex] = { ...last, content: last.content + delta };
                  }
                  return copy;
                });
              }
            } catch (err) {
              console.warn("Failed to parse leftover buffer:", leftover);
            }
          }
        }
      }
    } catch (err) {
      console.error("Error while reading stream:", err);
    } finally {
      setLoading(false);
      // release reader
      try { reader.releaseLock(); } catch {}
    }
  };

  return (
    <div className="chat-container">
      <h2>💬 Universal AI Chat</h2>

      <div className="chat-window" ref={chatRef}>
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div
              className="bubble"
              dangerouslySetInnerHTML={{
                __html: marked.parse(m.content ?? ""),
              }}
            />
          </div>
        ))}
        {loading && <div className="typing">Assistant is typing...</div>}
      </div>

      <div className="input-area">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Ask anything — not just code 😄"
        />
        <button onClick={callStreamApi} disabled={loading}>
          {loading ? "Streaming..." : "Send"}
        </button>
      </div>
    </div>
  );
}
