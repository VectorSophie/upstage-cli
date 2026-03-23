# upstage-cli

upstage-cli는 Upstage Solar Pro2를 기반으로 동작하는 에이전트형 터미널 UI(TUI)입니다. 터미널 안에서 코드 분석, 페어 프로그래밍, 자동화된 작업 수행을 일관된 흐름으로 지원합니다.

## 설치

아래 명령으로 저장소를 준비하고 실행할 수 있습니다.

```bash
npm install
npm start
```

## 환경 변수

upstage-cli 실행에 중요한 환경 변수는 다음과 같습니다.

*   `UPSTAGE_API_KEY`: Solar Pro2 모델 연동에 필요한 Upstage API 키
*   `EDITOR`: 외부 편집기 실행 명령 (예: `vim`, `nano`, `code --wait`), 기본값 `vim`
*   `SECURITY_OVERRIDE`: `true`로 설정하면 경로 기반 쓰기 보호를 해제 (주의 필요)
*   `UPSTAGE_VERIFY_STAGES`: 검증 단계 순서를 쉼표로 지정 (기본값: `run_linter,run_typecheck,run_tests`)
*   `UPSTAGE_DISCOVERY_COMMAND`: discovered tool 스펙(JSON 배열)을 출력하는 명령
*   `UPSTAGE_DISCOVERY_INVOKE_COMMAND`: discovered tool 실행 명령 (미설정 시 `UPSTAGE_DISCOVERY_COMMAND` 재사용)
*   `UPSTAGE_MCP_SERVERS_MODULE`: MCP 서버 배열을 export하는 모듈 경로(절대/상대 경로 모두 지원)

루트 디렉터리에 `.env` 파일을 두고 관리할 수 있습니다.

### 검증 단계 오버라이드

패치 적용 후 실행되는 검증 단계를 제어하려면 아래처럼 설정합니다.

```bash
UPSTAGE_VERIFY_STAGES=run_linter,run_tests
```

허용 단계: `run_linter`, `run_typecheck`, `run_tests`

### 런타임 확장 로딩 (Discovery/MCP)

Discovery 도구 등록/실행 예시:

```bash
UPSTAGE_DISCOVERY_COMMAND="node tools/discovery-bridge.mjs discover"
UPSTAGE_DISCOVERY_INVOKE_COMMAND="node tools/discovery-bridge.mjs invoke"
```

`discover` 명령은 다음 형태의 JSON 배열을 출력해야 합니다.

```json
[
  {
    "name": "project_lint",
    "description": "Run project lint",
    "risk": "medium",
    "actionClass": "exec",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  }
]
```

MCP 서버 모듈 로딩 예시:

```bash
UPSTAGE_MCP_SERVERS_MODULE=./tools/mcp-servers.mjs
```

```js
export default [
  {
    name: "repo",
    client: {
      async listTools() {
        return [];
      },
      async callTool(toolName, args, context) {
        return { toolName, args, context };
      }
    }
  }
];
```

## CLI 사용 예시

```bash
upstage
upstage chat
upstage ask -p "저장소 구조를 분석해줘"
upstage ask -p "이슈 #123을 고쳐줘" --confirm-patches
```

지원 옵션:

*   `-h`, `--help`
*   `-p`, `--prompt <text>`
*   `--no-stream`
*   `--model <model-name>`
*   `--session <session-id>`
*   `--new-session`
*   `--reset-session`
*   `--confirm-patches`
*   `--bridge-json`

## 대시보드 구성

upstage-cli 인터페이스는 두 영역으로 구성됩니다.

1.  **채팅(왼쪽 패널)**: 요청 입력, 에이전트 응답 확인, 패치/디프 미리보기
2.  **사이드바(오른쪽 패널)**: 작업 맥락과 상태 정보
    *   **Plan**: 현재 작업을 원자적 단계로 분해한 계획
    *   **Context**: 저장소 맵과 현재 맥락에 포함된 파일
    *   **Tools**: 최근 도구 실행 및 관찰 결과

## 키보드 단축키

| 단축키 | 동작 |
| :--- | :--- |
| `Tab` | Input, Chat, Sidebar 간 포커스 순환 |
| `Ctrl+S` | 세션 브라우저 토글 |
| `Ctrl+T` | 저장소 맵 토글 |
| `Ctrl+X` | 현재 입력을 외부 `EDITOR`에서 열기 |
| `Esc` | 내비게이션 모드 진입 (`j`/`k` 스크롤) |
| `Esc` (2회) | 세션 되돌리기 (직전 턴 취소) |
| `i` | 내비게이션 모드에서 입력 포커스 이동 |

## Plan 모드

복잡한 요청은 실행 전에 Plan 모드를 거칩니다. 에이전트가 문제를 단계별로 분해하고, 사이드바의 **Plan** 탭에서 진행 상황을 추적할 수 있습니다. 이 흐름은 작업의 투명성과 예측 가능성을 높입니다.

## 보안 정책

upstage-cli는 경로 범위 기반 쓰기 보호 정책을 적용합니다. 기본적으로 에이전트는 현재 작업 디렉터리(`process.cwd()`) 내부만 수정할 수 있습니다.

*   **제한된 쓰기**: 신뢰 경로 밖 파일 수정은 차단되며, `SECURITY_OVERRIDE=true`일 때만 허용
*   **확인 절차**: 셸 실행, 파일 쓰기 같은 고위험 작업은 상호작용 확인 절차를 통해 승인

## 슬래시 명령어

*   `/new`: 새 세션 시작
*   `/sessions`: 세션 브라우저 열기
*   `/tree`: 저장소 맵 열기
*   `/help`: 인앱 도움말 표시
*   `/lang <ko|en>`: 실행 중 UI 언어 전환
*   `/exit`: 애플리케이션 종료

## 실제 기능 테스트 방법

아래 순서대로 실행하면 주요 기능을 빠르게 검증할 수 있습니다.

### 1) 기본 품질 체크

```bash
npm run check
npm test
```

### 2) 비대화형(ask) 스모크 테스트

```bash
upstage ask -p "현재 디렉터리 파일 목록을 간단히 정리해줘"
upstage ask -p "src/agent/loop.js 구조를 설명해줘" --no-stream
```

확인 포인트:

* 응답이 정상 출력되는지
* `--no-stream`에서 토큰 스트리밍 없이 완료 응답이 오는지

### 3) 브리지 JSON 모드 테스트 (자동화/파이프라인)

```bash
upstage ask -p "README 파일 이름을 알려줘" --bridge-json
```

확인 포인트:

* stdout이 JSON line 이벤트(`token`, `event`, `result`)로 출력되는지
* 자동화 스크립트에서 파싱 가능한지

### 4) 세션 기능 테스트

```bash
upstage --new-session
upstage --session <session-id>
upstage --reset-session --session <session-id>
```

확인 포인트:

* 새 세션 생성/재개/초기화가 정상 동작하는지
* 세션 브라우저(`/sessions`)에서 최근 세션 목록이 보이는지

### 5) 승인(approval) 흐름 테스트

```bash
upstage ask -p "작은 텍스트 파일을 하나 생성해줘" --confirm-patches
```

확인 포인트:

* 고위험 작업 전에 승인 프롬프트가 뜨는지
* 거부 시 작업이 차단되는지

### 6) 검증 단계 오버라이드 테스트

```bash
UPSTAGE_VERIFY_STAGES=run_linter,run_tests upstage ask -p "아주 작은 코드 변경을 적용해줘" --confirm-patches
```

확인 포인트:

* 검증 로그에서 지정한 단계만 실행되는지

### 7) Discovery/MCP 확장 로딩 테스트

1. `UPSTAGE_DISCOVERY_COMMAND`/`UPSTAGE_DISCOVERY_INVOKE_COMMAND` 또는 `UPSTAGE_MCP_SERVERS_MODULE` 설정
2. `upstage` 실행 후 도구 목록(`/tools`) 또는 실제 요청으로 확장 도구 호출

확인 포인트:

* 확장 도구가 등록되어 노출되는지
* 호출 시 JSON 결과가 정상 관찰되는지
