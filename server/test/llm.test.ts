import { describe, expect, it } from "vitest";
import { forcedToolChoiceOk, isAnthropicModel, makeLlm, thinkingFor, toAnthropicMessages } from "../src/llm.ts";
import { loadConfig } from "../src/config.ts";

describe("fournisseur choisi par l'identifiant du modèle", () => {
  it("un ID nu part chez Anthropic, un profil Bedrock reste sur Bedrock", () => {
    expect(isAnthropicModel("claude-haiku-5-5")).toBe(true);
    expect(isAnthropicModel("eu.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(false);
    expect(isAnthropicModel("global.anthropic.claude-haiku-5-5")).toBe(false);
  });
  it("coupe la réflexion de la famille 5 avec le réglage que chaque modèle accepte", () => {
    expect(thinkingFor("claude-haiku-5-5")).toEqual({ type: "disabled" });
    expect(thinkingFor("claude-sonnet-5-5")).toEqual({ type: "between_tools" }); // « disabled » : 400
    expect(thinkingFor("claude-opus-5-5")).toBeUndefined(); // ne se coupe pas
    expect(thinkingFor("claude-sonnet-4-6")).toBeUndefined();
    expect(forcedToolChoiceOk("claude-sonnet-5-5")).toBe(false);
    expect(forcedToolChoiceOk("claude-haiku-5-5")).toBe(true);
  });
  it("refuse clairement un ID nu sans clé, sans appel réseau", async () => {
    const llm = makeLlm(loadConfig({ MELLA_LLM: "bedrock" } as NodeJS.ProcessEnv));
    await expect(llm.chat({ model: "claude-haiku-5-5", messages: [{ role: "user", content: "salut" }] })).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
  it("traduit les appels d'outils et leurs résultats", () => {
    const out = toAnthropicMessages([
      { role: "system", content: "persona" },
      { role: "user", content: "rappelle-moi à 9h" },
      { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "set_reminder", arguments: '{"at":"2026-10-16T09:00"}' } }] },
      { role: "tool", tool_call_id: "t1", content: '{"reminder":{"id":"a"}}' },
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(out[1].content).toEqual([{ type: "tool_use", id: "t1", name: "set_reminder", input: { at: "2026-10-16T09:00" } }]);
    expect(out[2].content).toEqual([{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: '{"reminder":{"id":"a"}}' }] }]);
  });
});

describe("serveur compatible OpenAI (modèle ouvert)", () => {
  it("traduit outils, choix forcé et résultats d'outils, et lit la réponse sans la pensée", async () => {
    const { openAiBody, parseOpenAi } = await import("../src/llm.ts");
    const body: any = openAiBody(
      {
        model: "open-agent",
        toolChoice: "any",
        tools: [{ name: "web_search", description: "chercher", parameters: { type: "object", properties: {} } }],
        messages: [
          { role: "system", content: "fixe<!--cache-->contexte" } as any,
          { role: "user", content: "salut" },
          { role: "assistant", content: null as any, tool_calls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "c1", content: "{\"ok\":true}" },
        ],
      },
      { thinking: false },
    );
    expect(body.tool_choice).toBe("required");
    expect(body.tools[0]).toEqual({ type: "function", function: { name: "web_search", description: "chercher", parameters: { type: "object", properties: {} } } });
    expect(body.messages[3]).toEqual({ role: "tool", content: "{\"ok\":true}", tool_call_id: "c1" });
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    const reply = parseOpenAi({ choices: [{ message: { content: "<think>hmm</think>Trouvé.", tool_calls: [{ id: "c2", function: { name: "remember", arguments: { fact: "x" } } }] } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
    expect(reply.text).toBe("Trouvé.");
    expect(reply.toolCalls[0].function).toEqual({ name: "remember", arguments: "{\"fact\":\"x\"}" });
    expect(reply.usage.inputTokens).toBe(10);
  });
});
