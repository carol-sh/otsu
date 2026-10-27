# LLM 계약 스파이크

`scripts/spike-llm.ts`로 Chat Completions API의 동작을 확인한 결과다. 실행기(`src/llm/`) 설계의 근거가 된다.

```bash
node scripts/spike-llm.ts --provider openai
node scripts/spike-llm.ts --provider openai --effort none
```

`--model`과 `--effort`를 주지 않으면 `data/.env`의 `LLM_MODEL`, `LLM_REASONING_EFFORT`를 쓴다.

## OpenAI `gpt-6-luna` (2026-10-27)

### `reasoning_effort: low`

Chat Completions에서 `tools`와 함께 보내면 400으로 거부된다. 오류 메시지는 다음과 같다.

> Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.

### `reasoning_effort: none`

| 확인 항목                                        | 결과                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `tools`와 `json_object`를 한 요청에              | 된다. 1라운드에 `finish_reason: tool_calls`로 `memory_read`를 호출했다                  |
| 도구 결과를 준 뒤의 최종 응답                    | 2라운드에 `finish_reason: stop`, 파싱되는 JSON 객체                                     |
| 강제 호출 (`tools` 유지 + `tool_choice: "none"`) | 도구를 부르지 않고 JSON 객체를 돌려줬다. 프롬프트 1887 중 1792 토큰이 캐시에서 읽혔다   |
| 캐시 읽기 필드                                   | `usage.prompt_tokens_details.cached_tokens`                                             |
| 캐시 쓰기 필드                                   | `usage.prompt_tokens_details.cache_write_tokens`. 첫 호출에서 prefix 전체가 여기 잡힌다 |
| 추론 토큰                                        | 0. 출력은 호출마다 20–44 토큰                                                           |
| 빈 응답                                          | 관찰되지 않았다                                                                         |

## OpenAI `gpt-5-mini` (2026-10-27, 기본 effort)

- `tools`와 `json_object`를 함께 쓸 수 있다. 결과는 위와 같다.
- `tools`를 뺀 강제 호출은 `cached_tokens: 0`이었다. 도구 정의가 캐시 prefix에 들어간다. `gpt-6-luna`에서 도구 없는 캐시 측정 1회차도 0이어서 같은 결론이다.
- 추론 토큰이 호출마다 64–384로 출력 대부분을 차지했다.

## 관찰

- 모델은 `next.at`에 `"아침"`이나 빈 문자열을 넣었고, `flow: end`에서 `next`를 비우기도 했다. 스파이크 프롬프트가 형식과 필수 여부를 말하지 않아서다. 하네스 규칙 블록에 ISO 8601 형식, 예시, "`next`는 항상 필수"를 넣는다. 위반은 설계대로 파싱 실패로 처리한다.

## DeepSeek

나중에 검토한다. 확인할 것은 `tools`와 `json_object` 동시 사용, usage의 `prompt_cache_hit_tokens`·`prompt_cache_miss_tokens`, 모델 ID다.

## 실행기 설계에 반영할 것

- 도구 라운드와 최종 응답 모두 `response_format: json_object`를 켠다.
- 상한을 넘긴 뒤의 강제 호출은 `tools`를 그대로 두고 `tool_choice: "none"`으로 막는다. prefix가 같아 캐시가 산다 (검증됨).
- 캐시 토큰은 provider별로 다른 필드에서 읽는다. OpenAI는 `prompt_tokens_details.cached_tokens`와 `cache_write_tokens`다.
- `reasoning_effort`는 설정(`LLM_REASONING_EFFORT`)으로 받고, 비어 있으면 요청에 넣지 않는다.
