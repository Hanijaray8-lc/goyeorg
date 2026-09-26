const AiConfig = require('./models/AiConfig');

/**
 * Generate an AI response for an incoming customer WhatsApp query using Groq & Gemini APIs.
 */
async function generateGoyeeAiReply({ knowledgeBase, customerPhone, customerName, customerMessage, apiKey }) {
    const systemPrompt = `You are "Goyee AI", a friendly, professional, 24/7 WhatsApp AI Customer Support & Sales Assistant for a business.

### BUSINESS KNOWLEDGE BASE (DOCUMENT CONTENT):
"""
${knowledgeBase || "No additional information provided."}
"""

### CHAT CONTEXT & USER DETAILS:
- Customer Phone: ${customerPhone || "Unknown"}
- Customer Name: ${customerName || "Customer"}

### STRICT INSTRUCTIONS:
1. Answer the customer's question strictly using ONLY the information from the BUSINESS KNOWLEDGE BASE above.
2. If the info is missing, politely reply: "I'm sorry, I don't have that specific information right now. Would you like me to connect you with our team manager?"
3. Keep answers concise, natural, and helpful (max 2 to 4 short sentences) with friendly emojis.
4. Detect language: If asked in Tamil / Tanglish / English, reply in friendly Tanglish / English.
5. Output ONLY the exact final WhatsApp reply message to be sent directly to the customer. Do NOT output rule lists, code blocks, or system notes.`;

    const userMessage = `Customer Question: "${customerMessage || "Hello"}"\n\nProvide the exact WhatsApp reply to send to this customer:`;

    let lastError = null;

    // 1. Try Groq API (Ultra-Fast 0.3s responses)
    const groqKey = (apiKey && String(apiKey).startsWith("gsk_"))
        ? String(apiKey).trim()
        : (process.env.GROQ_API_KEY || "").trim();

    if (groqKey) {
        const groqModels = [
            "openai/gpt-oss-120b",
            "openai/gpt-oss-20b",
            "qwen/qwen3.8-27b"
        ];

        for (const model of groqModels) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 4000);
                const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${groqKey}`
                    },
                    body: JSON.stringify({
                        model: model,
                        messages: [
                            { role: "system", content: systemPrompt },
                            { role: "user", content: userMessage }
                        ],
                        temperature: 0.2,
                        max_tokens: 600
                    }),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (res.ok) {
                    const data = await res.json();
                    const replyText = data.choices?.[0]?.message?.content;
                    if (replyText && replyText.trim()) {
                        let clean = replyText.trim();
                        if (clean.startsWith("```") && clean.endsWith("```")) {
                            clean = clean.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
                        }
                        return clean;
                    }
                }
            } catch (err) {
                console.warn(`[Goyee AI - Groq] Model ${model} failed:`, err.message);
                lastError = err;
            }
        }
    }

    // 2. Fallback to Gemini API
    const geminiKey = (apiKey && !String(apiKey).startsWith("gsk_") && String(apiKey).trim())
        ? String(apiKey).trim()
        : (process.env.GEMINI_API_KEY || "").trim();

    if (geminiKey) {
        const geminiModels = [
            "gemini-2.5-flash",
            "gemini-2.5-flash-lite",
            "gemini-3.5-flash-lite",
            "gemini-3.5-flash",
            "gemini-flash-latest"
        ];

        for (const model of geminiModels) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
                const response = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        contents: [
                            {
                                role: "user",
                                parts: [{ text: `${systemPrompt}\n\n${userMessage}` }]
                            }
                        ],
                        generationConfig: {
                            temperature: 0.2,
                            maxOutputTokens: 600
                        }
                    })
                });

                if (response.ok) {
                    const data = await response.json();
                    const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (replyText && replyText.trim()) {
                        let clean = replyText.trim();
                        if (clean.startsWith("```") && clean.endsWith("```")) {
                            clean = clean.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
                        }
                        return clean;
                    }
                }
            } catch (err) {
                console.warn(`[Goyee AI - Gemini] Model ${model} failed:`, err.message);
                lastError = err;
            }
        }
    }

    throw lastError || new Error("Failed to generate response from AI Service.");
}

module.exports = { generateGoyeeAiReply };