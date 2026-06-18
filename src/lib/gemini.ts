import { GoogleGenAI } from '@google/genai';
import { VertexAI } from '@google-cloud/vertexai';

/**
 * Gemini client with two backends:
 *   - Vertex AI (preferred): bills against your GCP project — used when
 *     GCP_PROJECT_ID is set. Picks up auth from Application Default Credentials
 *     (run `gcloud auth application-default login` once). Lets the $300 trial
 *     credit (or pay-as-you-go) cover everything cleanly.
 *   - AI Studio (fallback): legacy `GEMINI_API_KEY` path. Same Gemini models
 *     but billed through AI Studio's separate prepay/postpay system.
 *
 * Public surface is unchanged — `geminiSearch` / `geminiAsk` work identically
 * regardless of which backend is in use.
 */

// Evaluated lazily on each call so env-var changes (or late .env parsing
// in scripts) are picked up without re-importing the module.
const useVertex = () => !!process.env.GCP_PROJECT_ID;

// ── Vertex AI client (preferred) ──
// Auth precedence:
//   1. GOOGLE_APPLICATION_CREDENTIALS_JSON — full service-account JSON pasted
//      directly into an env var. This is the only path that works on Vercel +
//      other serverless hosts (no filesystem for a key file, no `gcloud`).
//   2. GOOGLE_APPLICATION_CREDENTIALS — filesystem path to a key JSON.
//   3. Application Default Credentials — picks up `~/.config/gcloud/...`
//      written by `gcloud auth application-default login` (local dev path).
let vertexClient: VertexAI | null = null;
function getVertex() {
  if (!vertexClient) {
    const opts: any = {
      project: process.env.GCP_PROJECT_ID!,
      location: process.env.GCP_LOCATION || 'us-central1',
    };
    const jsonStr = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (jsonStr) {
      try {
        const creds = JSON.parse(jsonStr);
        opts.googleAuthOptions = { credentials: creds };
      } catch (e) {
        console.error('GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON:', e);
      }
    }
    vertexClient = new VertexAI(opts);
  }
  return vertexClient;
}

// ── AI Studio client (legacy fallback) ──
let aiStudioClient: GoogleGenAI | null = null;
function getAiStudio() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Neither GCP_PROJECT_ID nor GEMINI_API_KEY is set');
  if (!aiStudioClient) aiStudioClient = new GoogleGenAI({ apiKey: key });
  return aiStudioClient;
}

type GeminiOpts = {
  temperature?: number;
  thinkingBudget?: number;
  model?: 'flash' | 'flash-lite';
  responseSchema?: any;
};

const modelNameFor = (m?: 'flash' | 'flash-lite') =>
  m === 'flash-lite' ? 'gemini-2.5-flash-lite' : 'gemini-2.5-flash';

/**
 * Ask Gemini with Google Search grounding enabled. Returns the raw text response.
 * Same retrieval stack as Google AI Mode answers.
 */
export async function geminiSearch(prompt: string, opts?: GeminiOpts): Promise<string> {
  const modelName = modelNameFor(opts?.model);
  if (useVertex()) {
    const model = getVertex().getGenerativeModel({
      model: modelName,
      generationConfig: { temperature: opts?.temperature ?? 0.3 },
      // Vertex Gemini 2.x renamed: `googleSearchRetrieval` → `googleSearch`
      tools: [{ googleSearch: {} } as any],
    });
    const res = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    return res.response?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || '';
  }
  // AI Studio fallback
  const res = await getAiStudio().models.generateContent({
    model: modelName,
    contents: prompt,
    config: {
      temperature: opts?.temperature ?? 0.3,
      tools: [{ googleSearch: {} }],
      ...(opts?.thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget: opts.thinkingBudget } } : {}),
    },
  });
  return res.text || '';
}

/**
 * Ask Gemini without web grounding — for prompts where the answer must come
 * from the context we provide (e.g. "find which of these contacts match X").
 */
export async function geminiAsk(prompt: string, opts?: GeminiOpts): Promise<string> {
  const modelName = modelNameFor(opts?.model);
  if (useVertex()) {
    const model = getVertex().getGenerativeModel({
      model: modelName,
      generationConfig: {
        temperature: opts?.temperature ?? 0.2,
        ...(opts?.responseSchema ? { responseMimeType: 'application/json', responseSchema: opts.responseSchema } : {}),
      },
    });
    const res = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    return res.response?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || '';
  }
  // AI Studio fallback
  const config: any = {
    temperature: opts?.temperature ?? 0.2,
    ...(opts?.thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget: opts.thinkingBudget } } : {}),
  };
  if (opts?.responseSchema) {
    config.responseMimeType = 'application/json';
    config.responseSchema = opts.responseSchema;
  }
  const res = await getAiStudio().models.generateContent({
    model: modelName,
    contents: prompt,
    config,
  });
  return res.text || '';
}
