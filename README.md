# slack2discord

A bridge service that forwards Slack channel messages to Discord in real time via webhook.

- Uses Slack **Socket Mode** — no public server URL required
- Customizable message transform hook (`transform.ts`)
- Bot message allowlist support
- Slack mrkdwn & Block Kit → Discord markdown conversion
- Per-channel ordering, graceful shutdown, and auto-restart under systemd

*(한국어 설명은 아래에 있습니다 — [바로가기](#slack2discord-한국어).)*

## Requirements

- Node.js 18+
- Ubuntu server with systemd (for the production service; any Node host works for `npm start`)

## Installation

Copy the templates first. `src/transform.ts` must exist for the build to succeed (it is gitignored and imported by the bridge); `.env` is read at runtime:

```bash
npm install
cp src/transform.example.ts src/transform.ts
cp .env.example .env
npm run build
```

## Configuration

Edit `.env` with your credentials:

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_APP_TOKEN` | ✅ | App-Level Token starting with `xapp-` |
| `SLACK_BOT_TOKEN` | ✅ | Bot Token starting with `xoxb-` |
| `DISCORD_WEBHOOK_URL` | ✅ | Discord channel webhook URL |
| `SLACK_CHANNEL_ALLOWLIST` | - | Channel IDs to forward (comma-separated, empty = all channels) |
| `SLACK_BOT_ALLOWLIST` | - | Bot IDs to allow (comma-separated, empty = block all bots) |
| `DISCORD_USERNAME` | - | Fixed display name in Discord (empty = use Slack sender name) |
| `DEBUG_LOG_CONTENT` | - | Set to `true` to log message content to stdout (disabled by default) |

## Slack App Setup

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps)
2. Enable **Socket Mode** → Basic Information > Socket Mode toggle ON
3. Create an **App-Level Token** → Basic Information > App-Level Tokens > `connections:write` scope → copy `xapp-...`
4. Enable **Event Subscriptions** → subscribe to `message.channels`
5. Add **Bot Token Scopes** → `channels:history`, `channels:read`, `users:read`
6. Install the app to your workspace → copy `xoxb-...`
7. Invite the bot to the target channel: `/invite @botname`

## Customizing the Transform

`src/transform.ts` controls how Slack messages appear in Discord. It is **gitignored** so your customizations stay local.

```typescript
// src/transform.ts
export function transform(ctx: TransformContext): DiscordPayload | null {
  // Return a DiscordPayload to forward, or null to drop the message.
  return ctx.payload; // default: forward as-is
}
```

Available context:

| Property | Description |
|----------|-------------|
| `ctx.event` | Raw Slack message event (text, blocks, attachments, files, ...) |
| `ctx.channelName` | Resolved Slack channel name (e.g. `general`) |
| `ctx.userName` | Resolved sender display name |
| `ctx.text` | Message body as Discord markdown (mrkdwn or Block Kit fallback, mentions resolved) |
| `ctx.payload` | Default Discord payload built by the bridge |

See [`examples/`](examples/) for real-world use cases.

## Previewing the Transform Offline

Fetch today's messages from Slack, run them through the **same** payload builder and `transform.ts` the live bridge uses, and write results to `preview.log` — nothing is sent to Discord.

```bash
npm run build
node dist/preview.js          # today's messages
node dist/preview.js 20       # last 20 messages
```

## Development

```bash
npm run dev         # run from source with ts-node (no build step)
npm run typecheck   # type-check without emitting
npm test            # run the unit tests (convert / blockkit / payload)
```

## Usage

### Direct (for testing)

```bash
npm start
```

### systemd service (production)

A ready-to-edit unit template is committed as [`slack2discord.service.example`](slack2discord.service.example):

```bash
cp slack2discord.service.example slack2discord.service
# edit User, WorkingDirectory, and ExecStart to match your server, then:
sudo cp slack2discord.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now slack2discord
```

Your edited `slack2discord.service` is gitignored so local paths stay out of git.

### Service management

```bash
# Check status
sudo systemctl status slack2discord

# Live logs
journalctl -u slack2discord -f

# Restart after rebuilding
npm run build && sudo systemctl restart slack2discord

# Stop
sudo systemctl stop slack2discord
```

## Behavior

| Situation | Behavior |
|-----------|----------|
| Bot message | Blocked unless bot ID is in `SLACK_BOT_ALLOWLIST` |
| Message from the bridge's own bot | Blocked (self-forwarding loop prevention) |
| `message_changed` / `message_deleted` / `channel_join` | Ignored |
| Slack `*bold*` → Discord `**bold**` | Auto-converted (arithmetic like `3 * 4` and paths like `~/dir` are left intact) |
| Slack `~strikethrough~` → Discord `~~strikethrough~~` | Auto-converted |
| HTML entities `&amp;` `&lt;` `&gt;` | Decoded to `&` `<` `>` |
| Channel mention `<#C...\|name>` / URL `<https://...\|text>` | Converted to `#name` / `[text](url)` |
| Bare mention `<@U...>` / `<#C...>` (no label) | Resolved to `@name` / `#name` via Slack API |
| Slack Block Kit | Text fallback forwarded; when absent, blocks are rendered to markdown |
| Slack attachment | Converted to Discord embed (empty/color-only attachments are skipped) |
| File attachment | Public files shown as links, private files marked `(private)` |
| Message empty after transform | Skipped — never sends an empty payload |
| Messages within one channel | Forwarded strictly in order (per-channel queue) |
| Discord rate limit (429) | Retried up to 3× honoring `retry_after` |
| `transform()` returns `null` | Message silently dropped |
| Error on one message | Logged, service keeps running |
| Server reboot | Auto-started on boot via the enabled unit (`WantedBy=multi-user.target`); crashes restart via `Restart=on-failure` |

## Finding a Bot ID

To allow a specific bot, you need its ID (starts with `B`). Check the logs:

```bash
journalctl -u slack2discord | grep "bot_id"
```

## Project Structure

```
src/
  index.ts            # Main bridge (Socket Mode listener, queue, shutdown)
  transform.ts        # Custom transform hook — gitignored, edit freely
  transform.example.ts# Default passthrough template
  payload.ts          # Builds the default Discord payload (shared, limit-enforcing)
  blockkit.ts         # Slack Block Kit → Discord markdown parser
  convert.ts          # Slack mrkdwn → Discord markdown converter
  types.ts            # Shared TypeScript interfaces
  preview.ts          # Offline transform preview (no Discord send)
  *.test.ts           # Unit tests (convert / blockkit / payload)
examples/
  transform.attendance.ts   # Attendance bot message formatting example
slack2discord.service.example # systemd unit template
```

## Roadmap & Open Questions

The bridge is intentionally small and does one thing well: forward new messages, right now, in order. That leaves plenty of deliberate open ground. These are directions worth exploring rather than a committed backlog — pick what your use case actually needs.

### Reliability
- **Missed-message catch-up.** Socket Mode does not replay events received while the process is down, so messages posted during a deploy or reboot are lost. A durable "last processed timestamp per channel" store (JSON file or SQLite) plus a startup catch-up pass would close that gap. The bridge was scaffolded for this earlier; a clean, tested implementation is the highest-value next step.
- **Backpressure & metrics.** The per-channel queue is unbounded. Under a burst it could grow without limit — a bounded queue, a global rate limiter, and basic counters (forwarded / dropped / retried) would make behavior observable and safe.

### Fidelity
- **Edits & deletions.** `message_changed` / `message_deleted` are currently ignored. Mapping Slack `ts` → Discord message ID (requires capturing the webhook response) would let edits and deletions propagate.
- **Threads.** Slack thread replies are forwarded flat. They could become Discord replies or land in Discord threads.
- **Richer Block Kit.** Images, section `fields`, and context blocks could map to native Discord embed images/fields instead of markdown approximations.
- **Avatars & reactions.** Forward the Slack sender's avatar as the webhook `avatar_url`, and optionally mirror reactions.

### Scope
- **Channel routing.** Today all traffic goes to one webhook. A Slack-channel → Discord-webhook map would allow fan-out to multiple Discord channels.
- **Bidirectional bridging.** Discord → Slack is a natural but much larger extension (needs a Discord bot, not just a webhook).

### Project hygiene
- **CI.** A GitHub Actions workflow running `npm run typecheck`, `npm test`, and `npm audit --audit-level=high` on every push would keep quality from regressing.
- **Fixtures.** Recorded Slack event payloads would enable integration tests for the full pipeline (not just the pure converters).
- **Docker.** A container image would be an alternative to systemd for non-Ubuntu hosts.

Contributions and discussion on any of these are welcome — the open questions are as valuable as the code.

---

# slack2discord (한국어)

Slack 채널 메시지를 Discord 웹훅으로 실시간 포워딩하는 브릿지 서비스.

- Slack **Socket Mode** 사용 — 공개 서버 URL 불필요
- 커스터마이징 가능한 메시지 변환 훅 (`transform.ts`)
- 봇 메시지 allowlist 지원
- Slack mrkdwn & Block Kit → Discord 마크다운 변환
- 채널별 순서 보장, 우아한 종료, systemd 자동 재시작

## 요구 사항

- Node.js 18+
- systemd를 갖춘 Ubuntu 서버 (운영용 서비스 기준; `npm start`는 어떤 Node 호스트에서도 동작)

## 설치

템플릿을 먼저 복사하세요. `src/transform.ts`는 빌드 시 필요하고(gitignore 처리되며 브릿지가 import함), `.env`는 실행 시 읽힙니다:

```bash
npm install
cp src/transform.example.ts src/transform.ts
cp .env.example .env
npm run build
```

## 환경변수 설정

`.env` 파일을 편집하세요:

| 변수 | 필수 | 설명 |
|------|------|------|
| `SLACK_APP_TOKEN` | ✅ | `xapp-` 로 시작하는 App-Level Token |
| `SLACK_BOT_TOKEN` | ✅ | `xoxb-` 로 시작하는 Bot Token |
| `DISCORD_WEBHOOK_URL` | ✅ | Discord 채널 웹훅 URL |
| `SLACK_CHANNEL_ALLOWLIST` | - | 포워딩할 채널 ID (콤마 구분, 비우면 전체 채널) |
| `SLACK_BOT_ALLOWLIST` | - | 허용할 봇 ID (콤마 구분, 비우면 모든 봇 차단) |
| `DISCORD_USERNAME` | - | Discord에 표시될 이름 고정 (비우면 Slack 발신자 이름) |
| `DEBUG_LOG_CONTENT` | - | `true` 설정 시 메시지 내용을 stdout에 로깅 (기본 비활성) |

## Slack 앱 설정

1. [api.slack.com/apps](https://api.slack.com/apps) 에서 앱 생성
2. **Socket Mode** 활성화 → Basic Information > Socket Mode 토글 ON
3. **App-Level Token** 발급 → Basic Information > App-Level Tokens > `connections:write` 권한 → `xapp-...` 복사
4. **Event Subscriptions** 활성화 → `message.channels` 구독 추가
5. **Bot Token Scopes** → `channels:history`, `channels:read`, `users:read` 추가
6. 워크스페이스에 앱 설치 → `xoxb-...` 복사
7. 봇을 포워딩할 채널에 `/invite @봇이름` 으로 초대

## 메시지 변환 커스터마이징

`src/transform.ts`에서 Slack 메시지가 Discord에 표시되는 방식을 제어합니다. 이 파일은 **gitignore**에 등록되어 있어 로컬 설정이 보호됩니다.

```typescript
// src/transform.ts
export function transform(ctx: TransformContext): DiscordPayload | null {
  // DiscordPayload를 반환하면 전송, null을 반환하면 드롭
  return ctx.payload; // 기본: 그대로 전달
}
```

사용 가능한 context:

| 속성 | 설명 |
|------|------|
| `ctx.event` | Slack 메시지 이벤트 원본 (text, blocks, attachments, files, ...) |
| `ctx.channelName` | Slack 채널 이름 (예: `general`) |
| `ctx.userName` | 발신자 표시 이름 |
| `ctx.text` | Discord 마크다운으로 변환된 본문 (mrkdwn 또는 Block Kit fallback, 멘션 해석 완료) |
| `ctx.payload` | 브릿지가 기본으로 생성한 Discord payload |

실제 사용 예시는 [`examples/`](examples/) 폴더를 참고하세요.

## 오프라인 변환 미리보기

오늘의 Slack 메시지를 가져와, 실제 브릿지와 **동일한** payload 빌더와 `transform.ts`로 실행하고 결과를 `preview.log`에 저장합니다. Discord로는 전송하지 않습니다.

```bash
npm run build
node dist/preview.js          # 오늘 메시지 전체
node dist/preview.js 20       # 최근 20개
```

## 개발

```bash
npm run dev         # ts-node로 소스에서 바로 실행 (빌드 불필요)
npm run typecheck   # emit 없이 타입 체크
npm test            # 단위 테스트 실행 (convert / blockkit / payload)
```

## 실행

### 직접 실행 (테스트용)

```bash
npm start
```

### systemd 서비스 등록 (운영)

바로 편집 가능한 유닛 템플릿을 [`slack2discord.service.example`](slack2discord.service.example)로 커밋해 두었습니다:

```bash
cp slack2discord.service.example slack2discord.service
# User, WorkingDirectory, ExecStart 를 실제 환경에 맞게 수정 후:
sudo cp slack2discord.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now slack2discord
```

편집한 `slack2discord.service`는 gitignore 처리되어 로컬 경로가 git에 올라가지 않습니다.

### 서비스 관리

```bash
# 상태 확인
sudo systemctl status slack2discord

# 로그 실시간 확인
journalctl -u slack2discord -f

# 빌드 후 재시작
npm run build && sudo systemctl restart slack2discord

# 중지
sudo systemctl stop slack2discord
```

## 동작 방식

| 상황 | 처리 |
|------|------|
| 봇 메시지 | `SLACK_BOT_ALLOWLIST`에 없으면 차단 |
| 브릿지 자신의 봇 메시지 | 차단 (자기 포워딩 루프 방지) |
| `message_changed` / `message_deleted` / `channel_join` | 무시 |
| Slack `*굵게*` → Discord `**굵게**` | 자동 변환 (`3 * 4` 같은 곱셈, `~/dir` 같은 경로는 보존) |
| Slack `~취소선~` → Discord `~~취소선~~` | 자동 변환 |
| HTML 엔티티 `&amp;` `&lt;` `&gt;` | `&` `<` `>` 로 디코딩 |
| 채널 멘션 `<#C...\|name>` / URL `<https://...\|텍스트>` | `#name` / `[텍스트](url)` 로 변환 |
| 라벨 없는 멘션 `<@U...>` / `<#C...>` | Slack API로 `@이름` / `#채널명` 해석 |
| Slack Block Kit | text fallback 전달, 없으면 blocks를 마크다운으로 렌더링 |
| Slack attachment | Discord embed로 변환 (내용 없는/색상만 있는 attachment는 생략) |
| 파일 첨부 | 공개 파일은 링크로, 비공개 파일은 `(private)` 표시 |
| transform 후 내용이 빈 메시지 | 생략 — 빈 payload를 절대 전송하지 않음 |
| 한 채널 내 메시지 | 순서대로 포워딩 (채널별 큐) |
| Discord rate limit (429) | `retry_after`를 존중해 최대 3회 재시도 |
| `transform()` 가 `null` 반환 | 메시지 드롭 |
| 개별 메시지 오류 | 로그 기록, 서비스 유지 |
| 서버 재부팅 | enable된 유닛(`WantedBy=multi-user.target`)으로 부팅 시 자동 시작; 크래시는 `Restart=on-failure`로 재시작 |

## 봇 ID 확인 방법

봇 메시지를 허용하려면 해당 봇의 ID(`B`로 시작)가 필요합니다:

```bash
journalctl -u slack2discord | grep "bot_id"
```

## 프로젝트 구조

```
src/
  index.ts            # 메인 브릿지 (Socket Mode 리스너, 큐, 종료 처리)
  transform.ts        # 커스텀 변환 훅 — gitignore 처리, 자유롭게 편집
  transform.example.ts# 기본 passthrough 템플릿
  payload.ts          # 기본 Discord payload 생성 (공유, 한도 강제)
  blockkit.ts         # Slack Block Kit → Discord 마크다운 파서
  convert.ts          # Slack mrkdwn → Discord 마크다운 변환기
  types.ts            # 공유 TypeScript 인터페이스
  preview.ts          # 오프라인 변환 미리보기 (Discord 전송 없음)
  *.test.ts           # 단위 테스트 (convert / blockkit / payload)
examples/
  transform.attendance.ts   # 근태봇 메시지 포맷 예시
slack2discord.service.example # systemd 유닛 템플릿
```

## 향후 과제 & 열린 질문

이 브릿지는 의도적으로 작게, 한 가지를 잘 하도록 만들어졌습니다: 새 메시지를 지금, 순서대로 전달하는 것. 그래서 남겨둔 여백이 많습니다. 아래는 확정된 백로그가 아니라 **탐색해볼 만한 방향**입니다 — 각자의 사용 사례에 실제로 필요한 것을 골라 가세요.

### 안정성
- **누락 메시지 캐치업.** Socket Mode는 프로세스가 내려가 있는 동안 받은 이벤트를 재전송하지 않으므로, 배포·재부팅 중 올라온 메시지는 유실됩니다. "채널별 마지막 처리 timestamp"를 영속 저장(JSON 파일 또는 SQLite)하고 기동 시 캐치업 패스를 도는 것이 이 공백을 메웁니다. 이전에 이를 위한 뼈대가 있었으니, 깔끔하고 테스트된 구현이 가장 가치 높은 다음 단계입니다.
- **백프레셔 & 메트릭.** 채널별 큐는 상한이 없습니다. 폭주 시 무한히 커질 수 있으니, 상한 큐·전역 rate limiter·기본 카운터(전달/드롭/재시도)로 동작을 관측 가능하고 안전하게 만들 수 있습니다.

### 충실도
- **수정 & 삭제.** 현재 `message_changed` / `message_deleted`는 무시됩니다. Slack `ts` → Discord 메시지 ID 매핑(웹훅 응답 캡처 필요)을 두면 수정·삭제를 전파할 수 있습니다.
- **스레드.** Slack 스레드 답글은 평면적으로 전달됩니다. Discord 답글이나 스레드로 매핑할 수 있습니다.
- **더 풍부한 Block Kit.** 이미지, section `fields`, context 블록을 마크다운 근사 대신 Discord 임베드의 이미지/필드로 매핑할 수 있습니다.
- **아바타 & 리액션.** Slack 발신자 아바타를 웹훅 `avatar_url`로 전달하고, 선택적으로 리액션도 미러링.

### 범위
- **채널 라우팅.** 지금은 모든 트래픽이 하나의 웹훅으로 갑니다. Slack 채널 → Discord 웹훅 매핑으로 여러 Discord 채널로 팬아웃할 수 있습니다.
- **양방향 브릿지.** Discord → Slack은 자연스럽지만 훨씬 큰 확장입니다(웹훅이 아니라 Discord 봇 필요).

### 프로젝트 위생
- **CI.** 매 푸시마다 `npm run typecheck`, `npm test`, `npm audit --audit-level=high`를 도는 GitHub Actions 워크플로우로 품질 회귀를 막을 수 있습니다.
- **픽스처.** 녹화된 Slack 이벤트 payload가 있으면 (순수 변환기뿐 아니라) 전체 파이프라인 통합 테스트가 가능합니다.
- **Docker.** 컨테이너 이미지는 비-Ubuntu 호스트를 위한 systemd 대안이 됩니다.

위 항목 어느 것이든 기여와 논의를 환영합니다 — 열린 질문은 코드만큼이나 가치 있습니다.
