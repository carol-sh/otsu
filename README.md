# 乙 (otsu)

LLM Agent가 주인이고 사용자가 도구인 개인용 텔레그램 봇이다. 하네스는 이벤트 큐 하나와 워커 하나로 사용자 답장, 예약 도달, 운영 명령, 기억 정리 호출을 직렬로 처리한다. 설계 문서는 저장소 밖에 둔다.

## 준비

1. 텔레그램 BotFather로 봇을 만들고 토큰을 받는다. 본인 chat_id도 확인한다.
2. `data/.env.example`을 `data/.env`로 복사하고 `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID`, `LLM_API_KEY`를 채운다.
3. `data/prompt.md`(시스템 프롬프트)와 `data/tasks.md`(과업 풀)를 쓴다.

`memory/`와 `otsu.db`는 처음 시작할 때 하네스가 만든다.

## 실행

Docker로 실행한다. `data/`가 컨테이너의 `/data`로 들어간다.

```bash
docker compose up --build -d
```

로컬에서 바로 실행할 수도 있다. Node 24와 pnpm이 필요하다.

```bash
pnpm install
pnpm start
```

처음에는 정지 상태다. 봇에게 `/resume`을 보내면 시작한다. `/pause`로 언제든 멈춘다.

## 데이터 디렉터리

| 경로          | 작성자 | 내용                                                             |
| ------------- | ------ | ---------------------------------------------------------------- |
| `.env`        | 사용자 | 설정. 이벤트마다 다시 읽는다. "시작할 때만" 값은 재시작해야 반영 |
| `prompt.md`   | 사용자 | 시스템 프롬프트. 매 호출 읽는다                                  |
| `tasks.md`    | 사용자 | 과업 풀. 매 호출 읽는다                                          |
| `memory/*.md` | LLM    | 장기 기억. 흐름이 끝날 때 정리 호출이 쓴다                       |
| `otsu.db`     | 하네스 | 상태, 스케줄, 흐름, 메시지, LLM 호출 기록 (SQLite)               |

경로는 `DATA_DIR` 기준이다(기본값 `./data`, 컨테이너에서는 `/data`).

## 개발

```bash
pnpm check
```

포맷, 린트, 타입 검사, 테스트를 한 번에 돈다. 실제 LLM API로 turn·cleanup 호출을 한 번씩 확인하려면 `node scripts/smoke-llm.ts`를 쓴다(`data/.env`의 키를 쓴다).

## E2E 점검

`data/.env.e2e.example`을 `data/.env`로 복사해 짧은 주기로 돌린다. `BLACKOUT`은 지금 시각에서 몇 분 뒤의 짧은 구간으로 바꾼다. OpenAI와 DeepSeek으로 한 번씩 돌린다.

- [ ] `/resume` 후 첫 메시지가 오고, 답장하면 디바운스 뒤 응답한다
- [ ] 흐름이 끝난 뒤 보낸 메시지에 응답하지 않는다
- [ ] 불가 시간대에 보낸 메시지에 응답하지 않고, 그 사이 예약은 시간대가 끝난 뒤 온다
- [ ] `/pause` 후 아무것도 오지 않고, `/resume`으로 다시 시작한다
- [ ] 디바운스 대기 중 `docker compose restart` 후 그 메시지에 응답한다
- [ ] 5000자가 넘는 응답이 두 메시지로 나뉘어 온다
- [ ] 봇을 차단하면 정지 상태가 된다(`otsu.db`의 `harness_state.mode`)
