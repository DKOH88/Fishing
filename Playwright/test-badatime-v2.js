/**
 * 바다타임 유속% 통합 테스트 v2
 * - 로컬 HTTP 서버로 앱 실행하여 실제 Worker API 호출 확인
 */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8765;

// 간단한 정적 파일 서버
function startServer() {
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            let filePath = path.join(ROOT, req.url === '/' ? 'index.html' : req.url);
            const ext = path.extname(filePath);
            const mimeTypes = {
                '.html': 'text/html', '.js': 'application/javascript',
                '.css': 'text/css', '.json': 'application/json',
                '.png': 'image/png', '.svg': 'image/svg+xml',
            };
            fs.readFile(filePath, (err, data) => {
                if (err) {
                    res.writeHead(404);
                    res.end('Not Found');
                    return;
                }
                res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
                res.end(data);
            });
        });
        server.listen(PORT, () => {
            console.log(`🖥️  로컬 서버: http://localhost:${PORT}`);
            resolve(server);
        });
    });
}

(async () => {
    const server = await startServer();
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 430, height: 932 } });

    // badatime API 응답 캡처
    const badatimeResponses = [];
    page.on('response', async resp => {
        if (resp.url().includes('/api/badatime')) {
            try {
                const body = await resp.json();
                badatimeResponses.push({ url: resp.url(), status: resp.status(), body });
            } catch {}
        }
    });

    // 콘솔 로그 수집
    const consoleLogs = [];
    page.on('console', msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));

    await page.goto(`http://localhost:${PORT}/`);
    console.log('📄 페이지 로드 완료 (localhost)');

    // 데이터 로딩 대기 (조위 + 물때 + badatime)
    await page.waitForTimeout(8000);

    // 물때 카드 확인
    const cardVisible = await page.evaluate(() => {
        const card = document.getElementById('mulddaeCard');
        return card ? getComputedStyle(card).display !== 'none' : false;
    });
    console.log(`📋 물때 카드 표시: ${cardVisible ? '✅' : '❌'}`);

    // 유속% 확인
    const pctInfo = await page.evaluate(() => {
        const el = document.querySelector('.mulddae-pct-value');
        if (!el) return null;
        return {
            text: el.textContent.trim(),
            title: el.getAttribute('title'),
        };
    });
    if (pctInfo) {
        console.log(`✅ 유속%: "${pctInfo.text}" (tooltip: ${pctInfo.title})`);
        if (pctInfo.text.includes('*')) {
            console.log('   → 조차 기반 추정값 (fallback)');
        } else if (pctInfo.text.includes('%')) {
            console.log('   → 바다타임 실데이터 ✓');
        }
    } else {
        console.log('❌ 유속% 요소 없음');
    }

    // 출처 표시 확인
    const sourceText = await page.evaluate(() => {
        const el = document.querySelector('.mulddae-pct-source');
        return el ? el.textContent.trim() : null;
    });
    if (sourceText) {
        console.log(`📌 출처: "${sourceText}"`);
    } else {
        console.log('📌 출처 태그 없음 (바다타임 데이터 사용)');
    }

    // 내부 상태 확인
    const stateInfo = await page.evaluate(() => {
        if (typeof mulddaeCardState === 'undefined' || !mulddaeCardState) return null;
        return {
            badatimePct: mulddaeCardState.badatimePct,
            rangePct: mulddaeCardState.rangePct,
            correctedPct: mulddaeCardState.correctedPct,
            stationCode: mulddaeCardState.stationCode,
            dateStr: mulddaeCardState.dateStr,
        };
    });
    if (stateInfo) {
        console.log(`\n📊 mulddaeCardState:`);
        console.log(`   station: ${stateInfo.stationCode}, date: ${stateInfo.dateStr}`);
        console.log(`   badatimePct: ${stateInfo.badatimePct}`);
        console.log(`   rangePct: ${stateInfo.rangePct}`);
        console.log(`   correctedPct: ${stateInfo.correctedPct}`);
    }

    // badatime API 응답
    console.log(`\n🌐 바다타임 API 호출: ${badatimeResponses.length}건`);
    badatimeResponses.forEach(r => {
        console.log(`   ${r.url}`);
        console.log(`   → ${JSON.stringify(r.body)}`);
    });

    // 관련 콘솔 로그
    const btLogs = consoleLogs.filter(l => l.includes('badatime') || l.includes('바다타임'));
    if (btLogs.length > 0) {
        console.log(`\n📋 badatime 관련 콘솔:`);
        btLogs.forEach(l => console.log(`   ${l}`));
    }

    // 스크린샷
    await page.screenshot({ path: 'C:/Vibe Coding/tide-info/Playwright/badatime-test-v2.png', fullPage: false });
    console.log('\n📸 스크린샷: badatime-test-v2.png');

    await browser.close();
    server.close();
})();
