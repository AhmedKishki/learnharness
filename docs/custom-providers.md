# Custom model providers

LearnHarness can register several independently named custom providers using its
existing Pi AI runtime. This is configuration wiring, not another agent runtime:
Pi owns the model protocols, request conversion, streaming, tools, thinking and
usage accounting. There is no additional dependency on Pi coding-agent.

## Configuration location

Create `models.json` in the LearnHarness app-data directory (the directory
containing `settings.json`; `LH_DATA_DIR` relocates it). LearnHarness does not read
`~/.pi/agent/models.json`, install a model server, or edit this file for you.
Custom-provider setup UI is not included yet. Once configured, models appear in
the existing model selectors when their credential/header references resolve.

The file uses Pi's `providers` / `models` structure. For example:

```json
{
  "providers": {
    "my-local-server": {
      "baseUrl": "http://127.0.0.1:11434/v1",
      "api": "openai-completions",
      "apiKey": "unused-local-key",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "maxTokensField": "max_tokens"
      },
      "models": [
        {
          "id": "your-installed-model",
          "name": "My local model",
          "contextWindow": 8192,
          "maxTokens": 1024,
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          }
        }
      ]
    },
    "my-gateway": {
      "baseUrl": "https://your-gateway.example/v1",
      "api": "openai-completions",
      "apiKey": "$MY_GATEWAY_API_KEY",
      "headers": { "X-Tenant": "${MY_GATEWAY_TENANT}" },
      "models": [
        {
          "id": "your-gateway-model-id",
          "contextWindow": 32768,
          "maxTokens": 4096,
          "cost": {
            "input": 1,
            "output": 3,
            "cacheRead": 0,
            "cacheWrite": 0
          }
        }
      ]
    }
  }
}
```

**Replace all example IDs, limits, prices and compatibility flags with the actual
server/model configuration.** These numbers are examples, not recommendations or
automatically detected capabilities. Rates are USD per million tokens. Explicit
zero rates are allowed; LearnHarness does not assume that custom gateways are
free. Verify the endpoint's billing independently.

Use the exact API base URL your server documents. LearnHarness does not append
`/v1`, discover models, infer capabilities from names, or download models. Ollama,
vLLM, LM Studio, 9router and other gateways work only to the extent that their
configured endpoint implements the selected Pi protocol and compatibility flags.
For a keyless OpenAI-compatible local server, supply an explicit nonempty dummy
`apiKey` as above: the native Pi OpenAI client requires a key. Omitting `apiKey`
leaves a provider unavailable rather than implying unauthenticated access.

## Supported fields

Provider fields: `name`, `baseUrl`, `api`, `apiKey`, `headers`, `authHeader`,
`compat`, and the explicit `models` array. Each model requires `id`,
`contextWindow`, `maxTokens`, and `cost` with all four base rates. Unlike Pi
coding-agent's defaults, LearnHarness never invents limits or prices.

Optional Pi model fields are `name`, `api`, `baseUrl`, `reasoning`, `input`,
`thinkingLevelMap`, `inputLimits`, `promptCache`, `samplingParams`,
`samplingParamsByThinkingLevel`, `headers`, and `compat`. Cost tiers and Pi's
exported compatibility schemas are supported. A model's `api` and `baseUrl`
override its provider's values; model headers override provider headers. Names
default to model IDs, `reasoning` defaults to false, and `input` defaults to
`["text"]`. Declare image input only when the server/model supports it. Existing
onboarding and vision-slot requirements are unchanged.

The native chat transports available in the pinned Pi AI 1.4.0 dependency are:
`openai-completions`, `openai-responses`, `anthropic-messages`,
`google-generative-ai`, `azure-openai-responses`, `google-vertex`,
`bedrock-converse-stream`, `mistral-conversations`, `openai-codex-responses`, and
`pi-messages`. Protocol availability does **not** establish account access,
OAuth support, cloud credentials, subscription permission, or vendor approval.
This feature adds no login flows. In particular, an Anthropic Messages endpoint
is not a Claude Agent SDK or Claude Code runtime.

Use new provider IDs; built-in and subscription-route IDs cannot be replaced.
Provider IDs must be nonempty and cannot contain `:` (the provider/model
coordinate separator). Model IDs must be unique within a provider. Built-in
provider overrides, `modelOverrides`, OAuth definitions, executable plugins, and
automatic discovery are outside this phase.

## Credentials and trust

API keys and header values accept literals, `$NAME`, and `${NAME}`. References
use LearnHarness's existing key lookup: environment first, then the existing
flat `auth.json` file, respecting the fresh-user environment-ignore setting.
There is no auth migration or new secret file format. Prefer references over
putting secrets into `models.json`; protect any file containing literal secrets.
Unknown variable references keep the provider unavailable. All required header
references, including model-specific ones, must resolve before a provider becomes
available. An empty key does not configure a provider.

Pi's `$$` and `$!` literal escapes are supported. `!command` credential/header
values are rejected, never executed; resolved environment/file values are data,
not commands. Optional `authHeader: true` adds `Authorization: Bearer <key>` in
addition to the selected native transport's normal authentication behavior.

Only trusted people should edit this file: its endpoints receive model prompts,
attachments, tool results and configured credentials. Only HTTP(S) URLs are
accepted, without embedded URL credentials or fragments. This is not an
arbitrary-endpoint discovery or config-editing API and does not add a network
sandbox, endpoint reachability checks, or vendor policy exemptions.

## Reloading and failures

Changes take effect on the next catalog, settings-validation, or inference
operation without restarting. Credential/header reference changes are also
picked up through the existing key lookup. Every upstream model operation
revalidates the same saved provider/model ID against the current Pi catalog,
including later requests inside a long-running agent/tool loop. It uses the
current endpoint, model metadata and resolved credentials. A removed model,
invalid configuration or missing credential blocks the next operation, without
falling back. An HTTP operation already in flight retains its own native Pi
setup and is not implicitly cancelled by a file edit.

Deleting the file means no custom providers. Invalid JSON, invalid metadata,
reserved IDs, unsupported configuration, or an unreadable file disables the
custom routes, **not** built-in providers. The file accepts Pi's line comments
and trailing commas. `GET /api/models` includes an optional sanitized
`customProvidersError` diagnostic; rendering it in setup/settings UI is deferred.
Correcting the file restores valid providers on the next operation.

Saved selections and thinking preferences are not erased when a provider/model
is removed or becomes unavailable. New work using an unavailable selection fails
rather than falling back to another model. Select another configured model to
repair the slot. Custom-provider removal does not rewrite historical records;
like existing API-key models, historical cost estimates use the current catalog
and become unknown when the relevant model definition is unavailable.
