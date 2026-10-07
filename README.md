# AI Teach-Up 토론 도우미

AI Teach-Up 기획안의 제한형 대화 규칙을 반영한 수업용 챗봇입니다. BAZE의 OpenAI 호환 API Gateway를 서버에서 호출하므로 API 키가 학생의 브라우저에 노출되지 않습니다.

## 포함 기능

- 요청당 글자 수, 대화당 사용 횟수, 누적 입력 글자 수의 서버 강제 제한
- 공백·문장부호·줄바꿈을 포함하는 한글 친화적 글자 계산
- 읽을 수 있는 응답이 생성된 경우에만 사용 횟수 차감
- 대화별 분리된 세션과 남은 횟수·글자 수 표시
- 일부 사용팀(B), 반론 전용팀(C), 자유 사용팀(D)의 조건별 사용 구간과 한도 강제
- 중복 전송 방지, 60초 타임아웃, API 오류 처리
- 모바일과 PC에서 사용할 수 있는 반응형 화면
- API 키와 모델을 코드 수정 없이 환경변수로 교체
- 학생 이름·번호별 사용량 저장과 비밀번호로 보호되는 관리자 페이지
- 관리자 추가 횟수·글자 수 지급 및 사용량 초기화

## 실행

Node.js 20 이상과 Git이 필요합니다. 저장소를 내려받은 뒤 프로젝트 폴더에서 설정합니다.

```powershell
git clone https://github.com/aviniy/ai-teach-up-chatbot.git
Set-Location ai-teach-up-chatbot
npm install
Copy-Item .env.example .env
notepad .env
```

열린 `.env` 파일에서 다음 항목을 설정합니다.

1. BAZE에서 발급한 API 키를 `BAZE_API_KEY`에 입력합니다.
2. Gateway의 사용 가능 모델 ID를 확인하여 필요하면 `BAZE_MODEL`을 바꿉니다.
3. `ADMIN_PASSWORD`를 원하는 관리자 비밀번호로 변경합니다.

로컬에서만 실행하려면 다음 명령을 사용합니다.

```powershell
npm start
```

브라우저에서 `http://localhost:3210`을 엽니다.

## 노트북에서 외부 공개

프로젝트 폴더에 있는 아래 파일을 더블클릭하면 됩니다.

- `AI-Teach-Up-START.bat`: 서버 로그 창과 외부 접속 주소 창을 각각 엽니다.
- `AI-Teach-Up-STATUS.bat`: 현재 실행 상태, 학생용 주소, 관리자 주소를 확인합니다.
- `AI-Teach-Up-STOP.bat`: 서버와 외부 접속 터널을 모두 종료합니다.

첫 실행에는 공식 GitHub 릴리스에서 `cloudflared.exe`를 자동으로 내려받으므로 인터넷 연결이 필요합니다. 다운로드한 실행 파일과 로그는 Git에 포함되지 않습니다.

명령줄에서는 아래 명령으로 동일하게 실행할 수 있습니다.

```powershell
npm run public
```

`AI Teach-Up - Public URL` 창에 표시되는 `https://...trycloudflare.com` 주소를 학생들에게 공유하세요. 이 주소는 실행할 때마다 바뀌며, 서버를 종료하거나 노트북이 절전·종료되면 접속할 수 없습니다. 관리자 페이지는 해당 주소 뒤에 `/admin`을 붙이면 됩니다.

학생 사용 기록은 `data/sessions.json`에, 실행 로그는 `.runtime/server.log`와 `.runtime/tunnel.log`에 로컬 저장됩니다.

## 제한 설정

`.env`에서 아래 값을 바꾸고 서버를 다시 시작합니다. `0`은 제한 없음입니다.

```dotenv
MAX_PROMPT_CHARS=60
MAX_TURNS=5
MAX_TOTAL_CHARS=300
```

일부 사용팀(B)은 초기 준비와 반론 준비에서 합계 5회, 반론 전용팀(C)은 반론 준비에서만 5회 사용할 수 있습니다. 두 팀은 회당 60자, 누적 300자 제한을 공유합니다. 자유 사용팀(D)은 두 준비 구간에서 횟수와 글자 제한 없이 사용할 수 있습니다. A팀은 생성형 AI를 사용하지 않는 조건이므로 이 챗봇을 제공하지 않는 방식으로 운영합니다.

## 배포 시 확인할 점

- 공개 배포판은 학생별 사용량을 D1 데이터베이스에 저장합니다. 관리자 페이지는 `/admin`에서 열 수 있습니다.
- `ADMIN_PASSWORD`와 `SESSION_SIGNING_SECRET`은 반드시 호스팅 비밀 환경변수로 관리하세요.
- HTTPS 뒤에 배포하고 `.env`를 저장소에 올리지 마세요.
- 수업 시작 전 FactChat에서 실제 사용 가능한 모델 ID, 무료 크레딧, 기관 정책을 다시 확인하세요.
- 학생 개인정보나 민감한 자료를 시스템 프롬프트 또는 질문에 포함하지 않도록 안내하세요.

## 테스트

```powershell
npm test
```
