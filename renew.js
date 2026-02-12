const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// 截图目录
const SCREENSHOT_DIR = path.join(process.cwd(), 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// 生成安全文件名
function getSafeUsername(username) {
    return username.replace(/[^a-z0-9]/gi, '_');
}

// 保存截图
async function saveScreenshot(page, filename) {
    const filepath = path.join(SCREENSHOT_DIR, filename);
    try {
        await page.screenshot({ path: filepath, fullPage: true });
        console.log(`📸 截图已保存: ${filename}`);
        return filepath;
    } catch (e) {
        console.error('截图失败:', e.message);
        return null;
    }
}

// 发送 Telegram 消息
async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        console.log('[Telegram] 未配置，跳过发送');
        return;
    }

    // 1. 发送文字消息
    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TG_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log('[Telegram] 文字消息已发送');
    } catch (e) {
        console.error('[Telegram] 文字消息发送失败:', e.message);
    }

    // 2. 发送图片
    if (imagePath && fs.existsSync(imagePath)) {
        console.log('[Telegram] 正在发送图片...');
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}" -F caption="Debug Screenshot"`;
        
        await new Promise(resolve => {
            exec(cmd, (err) => {
                if (err) console.error('[Telegram] 图片发送失败:', err.message);
                else console.log('[Telegram] 图片已发送');
                resolve();
            });
        });
    }
}

// 启用 stealth 插件
chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;

process.env.NO_PROXY = 'localhost,127.0.0.1';

// Proxy Configuration
const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;

if (HTTP_PROXY) {
    try {
        const proxyUrl = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
        };
        console.log(`[代理] 配置: ${PROXY_CONFIG.server}, 认证: ${PROXY_CONFIG.username ? '是' : '否'}`);
    } catch (e) {
        console.error('[代理] 格式无效，期望: http://user:pass@host:port');
        process.exit(1);
    }
}

// 注入脚本：检测 Turnstile 坐标
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;

    function getRandomInt(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }
    
    let screenX = getRandomInt(800, 1200);
    let screenY = getRandomInt(400, 600);
    
    try {
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }

    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio, found: true };
                            return true;
                        }
                    }
                    return false;
                };

                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => {
                        if (checkAndReport()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) {
        console.error('[注入] Hook 失败:', e);
    }
})();
`;

async function checkProxy() {
    if (!PROXY_CONFIG) return true;
    console.log('[代理] 验证连接...');
    try {
        const axiosConfig = {
            proxy: {
                protocol: 'http',
                host: new URL(PROXY_CONFIG.server).hostname,
                port: parseInt(new URL(PROXY_CONFIG.server).port),
            },
            timeout: 10000
        };
        if (PROXY_CONFIG.username) {
            axiosConfig.proxy.auth = {
                username: PROXY_CONFIG.username,
                password: PROXY_CONFIG.password
            };
        }
        await axios.get('https://www.google.com', axiosConfig);
        console.log('[代理] 连接成功');
        return true;
    } catch (error) {
        console.error(`[代理] 连接失败: ${error.message}`);
        return false;
    }
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, (res) => {
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchChrome() {
    console.log('检查 Chrome 是否已在端口 ' + DEBUG_PORT + ' 上运行...');
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome 已开启');
        return;
    }

    console.log(`正在启动 Chrome: ${CHROME_PATH}`);

    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data',
        '--disable-dev-shm-usage'
    ];

    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }

    const chrome = spawn(CHROME_PATH, args, {
        detached: true,
        stdio: 'ignore'
    });
    chrome.unref();

    console.log('等待 Chrome 初始化...');
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }

    if (!await checkPort(DEBUG_PORT)) {
        throw new Error('Chrome 启动失败');
    }
    console.log('Chrome 启动成功');
}

function getUsers() {
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) {
        console.error('解析 USERS_JSON 错误:', e);
    }
    return [];
}

// 处理 Turnstile 验证（通用函数）
async function handleTurnstile(page, contextName = '未知') {
    console.log(`[${contextName}] 检查 Turnstile...`);
    
    const frames = page.frames();
    const turnstileFrame = frames.find(f => 
        f.url().includes('turnstile') || 
        f.url().includes('cloudflare') ||
        f.url().includes('challenges')
    );
    
    if (!turnstileFrame) {
        console.log(`[${contextName}] 未发现 Turnstile iframe`);
        return { success: false, reason: 'not_found' };
    }
    
    console.log(`[${contextName}] ✅ 发现 Turnstile，尝试验证...`);
    
    try {
        // 方法1: 使用注入脚本获取精确坐标
        const turnstileData = await turnstileFrame.evaluate(() => window.__turnstile_data).catch(() => null);
        
        if (turnstileData && turnstileData.found) {
            const iframeElement = await turnstileFrame.frameElement();
            const box = await iframeElement.boundingBox();
            
            if (box) {
                const clickX = box.x + (box.width * turnstileData.xRatio);
                const clickY = box.y + (box.height * turnstileData.yRatio);
                
                console.log(`[${contextName}] 使用 CDP 点击: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
                
                const client = await page.context().newCDPSession(page);
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed',
                    x: clickX,
                    y: clickY,
                    button: 'left',
                    clickCount: 1
                });
                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased',
                    x: clickX,
                    y: clickY,
                    button: 'left',
                    clickCount: 1
                });
                await client.detach();
            }
        } else {
            // 方法2: 点击 iframe 中心
            console.log(`[${contextName}] 使用备用方法：点击中心`);
            const iframeElement = await turnstileFrame.frameElement();
            const box = await iframeElement.boundingBox();
            if (box) {
                await page.mouse.click(box.x + box.width/2, box.y + box.height/2);
            }
        }
        
        // 等待验证结果
        await page.waitForTimeout(3000);
        
        // 检查验证状态
        for (let i = 0; i < 10; i++) {
            try {
                const success = await turnstileFrame.getByText('Success', { exact: false }).isVisible().catch(() => false);
                const verified = await turnstileFrame.evaluate(() => {
                    const checkbox = document.querySelector('input[type="checkbox"]');
                    return checkbox ? checkbox.checked : false;
                }).catch(() => false);
                
                if (success || verified) {
                    console.log(`[${contextName}] ✅ Turnstile 验证成功`);
                    return { success: true };
                }
            } catch (e) {}
            await page.waitForTimeout(500);
        }
        
        console.log(`[${contextName}] ⚠️ Turnstile 状态未知`);
        return { success: false, reason: 'timeout' };
        
    } catch (e) {
        console.error(`[${contextName}] Turnstile 处理错误:`, e.message);
        return { success: false, reason: 'error', error: e.message };
    }
}

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.error('未找到用户配置');
        process.exit(1);
    }

    if (PROXY_CONFIG) {
        const isValid = await checkProxy();
        if (!isValid) {
            console.error('[代理] 无效，终止');
            process.exit(1);
        }
    }

    await launchChrome();

    console.log('连接 Chrome...');
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            console.log('连接成功');
            break;
        } catch (e) {
            console.log(`连接尝试 ${k + 1} 失败，重试...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    if (!browser) {
        console.error('连接失败');
        process.exit(1);
    }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        await context.setHTTPCredentials({
            username: PROXY_CONFIG.username,
            password: PROXY_CONFIG.password
        });
    }

    await page.addInitScript(INJECTED_SCRIPT);
    console.log('注入脚本已添加');

    // 处理每个用户
    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const safeUser = getSafeUsername(user.username);
        console.log(`\n=== 用户 ${i + 1}/${users.length}: ${user.username} ===`);
        
        let status = 'unknown';
        let message = '';
        let finalScreenshot = null;
        let renewInfo = null; // 存储续期信息

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                await page.addInitScript(INJECTED_SCRIPT);
            }

            // 1. 进入登录页（Zampto）
            console.log('导航到 Zampto 登录页...');
            await page.goto('https://auth.zampto.net/sign-in');
            await page.waitForTimeout(2000);
            
            // 截图：登录页初始状态
            const loginInitShot = await saveScreenshot(page, `${safeUser}_01_login_init.png`);
            await sendTelegramMessage(`🔄 开始处理用户: ${user.username}\n步骤: 进入登录页`, loginInitShot);

            // 2. 输入邮箱/用户名
            console.log('输入邮箱...');
            // 根据图1，输入框是 "用户名 / 邮箱"
            const emailInput = page.locator('input[type="text"], input[type="email"]').first();
            await emailInput.waitFor({ state: 'visible', timeout: 10000 });
            await emailInput.fill(user.username);
            await page.waitForTimeout(500);

            // 截图：填写邮箱后
            const emailFilledShot = await saveScreenshot(page, `${safeUser}_02_email_filled.png`);

            // 3. 点击登录按钮（跳转到密码页）
            console.log('点击登录按钮...');
            // 图1中的蓝色"登录"按钮
            await page.getByRole('button', { name: /登录|Login|Sign in/i }).click();
            
            await page.waitForTimeout(3000);
            
            // 截图：密码页
            const passwordPageShot = await saveScreenshot(page, `${safeUser}_03_password_page.png`);

            // 4. 输入密码（图2）
            console.log('输入密码...');
            // 图2中的密码输入框
            const pwdInput = page.locator('input[type="password"]').first();
            await pwdInput.waitFor({ state: 'visible', timeout: 10000 });
            await pwdInput.fill(user.password);
            await page.waitForTimeout(500);

            // 截图：密码填写后
            const pwdFilledShot = await saveScreenshot(page, `${safeUser}_04_pwd_filled.png`);

            // 5. 点击继续按钮
            console.log('点击继续按钮...');
            // 图2中的"继续"按钮
            await page.getByRole('button', { name: /继续|Continue/i }).click();
            
            await page.waitForTimeout(4000);
            
            // 截图：登录后
            const afterLoginShot = await saveScreenshot(page, `${safeUser}_05_after_login.png`);

            // 6. 检查登录结果
            if (page.url().includes('sign-in') || page.url().includes('login')) {
                // 登录失败
                let failReason = '未知错误';
                try {
                    const errorLoc = page.locator('.error, .alert, [role="alert"]').first();
                    if (await errorLoc.isVisible({ timeout: 2000 })) {
                        failReason = await errorLoc.innerText();
                    }
                } catch (e) {}
                
                console.error(`❌ 登录失败: ${failReason}`);
                status = 'login_failed';
                message = `❌ *登录失败*\n用户: ${user.username}\n原因: ${failReason}`;
                finalScreenshot = afterLoginShot;
                
                await sendTelegramMessage(message, finalScreenshot);
                continue;
            }

            console.log('✅ 登录成功，当前 URL:', page.url());
            await sendTelegramMessage(`✅ 用户 ${user.username} 登录成功\nURL: ${page.url()}`, afterLoginShot);

            // 7. 点击 "Servers Overview"（图3左侧菜单）
            console.log('点击 Servers Overview...');
            try {
                // 左侧菜单中的 Servers Overview
                await page.getByRole('link', { name: /Servers Overview/i }).click();
                console.log('✅ 已点击 Servers Overview');
            } catch (e) {
                console.log('尝试通过文本查找...');
                await page.locator('text=Servers Overview').first().click();
            }
            
            await page.waitForTimeout(3000);
            
            // 截图：服务器概览页
            const serversOverviewShot = await saveScreenshot(page, `${safeUser}_06_servers_overview.png`);

            // 8. 获取服务器列表并处理每个服务器（图4）
            console.log('获取服务器列表...');
            
            // 查找所有服务器卡片（图4显示有 node14python 和 mywebsiteboom）
            const serverCards = await page.locator('[class*="server"], [class*="card"], .server-item, div:has-text("Manage Server")').all();
            console.log(`找到 ${serverCards.length} 个服务器元素`);
            
            // 更可靠的方式：查找所有包含 "Manage Server" 按钮的容器
            const manageButtons = await page.getByRole('button', { name: /Manage Server/i }).all();
            console.log(`找到 ${manageButtons.length} 个 Manage Server 按钮`);
            
            if (manageButtons.length === 0) {
                console.log('❌ 未找到服务器');
                status = 'no_servers';
                message = `❌ *未找到服务器*\n用户: ${user.username}`;
                finalScreenshot = serversOverviewShot;
                await sendTelegramMessage(message, finalScreenshot);
                continue;
            }

            // 处理每个服务器
            for (let serverIdx = 0; serverIdx < manageButtons.length; serverIdx++) {
                console.log(`\n--- 处理第 ${serverIdx + 1}/${manageButtons.length} 个服务器 ---`);
                
                // 重新获取按钮（因为页面可能已刷新）
                const currentButtons = await page.getByRole('button', { name: /Manage Server/i }).all();
                if (serverIdx >= currentButtons.length) break;
                
                const btn = currentButtons[serverIdx];
                
                // 获取服务器名称（在按钮附近的元素中）
                let serverName = 'Unknown';
                try {
                    // 尝试找到服务器名称（通常在卡片标题中）
                    const card = await btn.locator('..').locator('..').locator('..'); // 向上查找父元素
                    const titleEl = await card.locator('h3, h4, .title, [class*="name"]').first();
                    if (await titleEl.isVisible({ timeout: 1000 })) {
                        serverName = await titleEl.innerText();
                    }
                } catch (e) {
                    serverName = `Server-${serverIdx + 1}`;
                }
                
                console.log(`服务器名称: ${serverName}`);
                
                // 点击 Manage Server
                await btn.click();
                console.log('✅ 已点击 Manage Server');
                
                await page.waitForTimeout(3000);
                
                // 截图：服务器详情页（图5）
                const serverDetailShot = await saveScreenshot(page, `${safeUser}_07_server_${serverIdx + 1}_detail.png`);

                // 9. 查找并点击 Renew Server 按钮（图5右侧）
                console.log('查找 Renew Server 按钮...');
                
                let renewBtn = null;
                try {
                    // 图5中紫色的 "Renew Server" 按钮
                    renewBtn = page.getByRole('button', { name: /Renew Server/i });
                    await renewBtn.waitFor({ state: 'visible', timeout: 5000 });
                } catch (e) {
                    console.log('未找到 Renew Server 按钮，可能已过期或不需要续期');
                    
                    // 检查是否显示过期信息
                    const expiredText = await page.locator('text=Expired').isVisible().catch(() => false);
                    if (expiredText) {
                        console.log('服务器已过期');
                    }
                    
                    // 返回服务器列表
                    await page.goBack();
                    await page.waitForTimeout(2000);
                    continue;
                }

                // 获取续期前的信息（图7中的信息）
                console.log('获取当前续期信息...');
                let beforeRenewInfo = {};
                try {
                    // 查找 Renew 区域的信息
                    const renewSection = page.locator('div:has-text("Renew"), div:has-text("Server last renewed")').first();
                    const infoText = await renewSection.innerText({ timeout: 3000 });
                    
                    // 解析信息
                    const lastRenewedMatch = infoText.match(/Server last renewed:\s*(.+)/i);
                    const expiryMatch = infoText.match(/Expiry.*?:(.+)/i);
                    
                    beforeRenewInfo = {
                        lastRenewed: lastRenewedMatch ? lastRenewedMatch[1].trim() : 'Unknown',
                        expiry: expiryMatch ? expiryMatch[1].trim() : 'Unknown'
                    };
                    
                    console.log('续期前信息:', beforeRenewInfo);
                } catch (e) {
                    console.log('无法获取续期信息:', e.message);
                }

                // 点击 Renew Server 按钮
                await renewBtn.click();
                console.log('✅ 已点击 Renew Server');
                
                await page.waitForTimeout(2000);
                
                // 截图：续期弹窗（图6）
                const renewModalShot = await saveScreenshot(page, `${safeUser}_08_renew_modal.png`);

                // 10. 处理人机验证（图6）
                console.log('处理人机验证...');
                
                // 等待验证框出现
                await page.waitForTimeout(2000);
                
                const turnstileResult = await handleTurnstile(page, 'Renew-Modal');
                
                if (!turnstileResult.success) {
                    console.log('⚠️ Turnstile 可能未通过，继续等待...');
                }
                
                // 等待验证完成
                await page.waitForTimeout(5000);
                
                // 截图：验证后
                const afterVerifyShot = await saveScreenshot(page, `${safeUser}_09_after_verify.png`);

                // 11. 获取续期后的信息（图7）
                console.log('获取续期后信息...');
                
                // 等待信息更新
                await page.waitForTimeout(3000);
                
                try {
                    // 查找 Renew 区域
                    const renewSection = page.locator('div:has-text("Renew"), div:has-text("Server last renewed")').first();
                    const infoText = await renewSection.innerText({ timeout: 5000 });
                    
                    // 解析更新后的信息
                    const lastRenewedMatch = infoText.match(/Server last renewed:\s*(.+)/i);
                    const expiryMatch = infoText.match(/Expiry.*?:(.+)/i);
                    
                    renewInfo = {
                        serverName: serverName,
                        lastRenewed: lastRenewedMatch ? lastRenewedMatch[1].trim() : 'Unknown',
                        expiry: expiryMatch ? expiryMatch[1].trim() : 'Unknown',
                        beforeLastRenewed: beforeRenewInfo.lastRenewed,
                        beforeExpiry: beforeRenewInfo.expiry
                    };
                    
                    console.log('续期后信息:', renewInfo);
                    
                    // 判断续期是否成功（时间是否更新）
                    const isRenewed = renewInfo.lastRenewed !== renewInfo.beforeLastRenewed;
                    
                    if (isRenewed) {
                        status = 'success';
                        message = `✅ *服务器续期成功*\n\n` +
                                  `👤 用户: ${user.username}\n` +
                                  `🖥️ 服务器: ${serverName}\n\n` +
                                  `📅 *续期前:*\n` +
                                  `   上次续期: ${renewInfo.beforeLastRenewed}\n` +
                                  `   过期时间: ${renewInfo.beforeExpiry}\n\n` +
                                  `📅 *续期后:*\n` +
                                  `   上次续期: ${renewInfo.lastRenewed}\n` +
                                  `   过期时间: ${renewInfo.expiry}`;
                    } else {
                        status = 'no_change';
                        message = `⚠️ *续期状态未变化*\n\n` +
                                  `👤 用户: ${user.username}\n` +
                                  `🖥️ 服务器: ${serverName}\n\n` +
                                  `可能原因: 未到续期时间或验证未通过\n\n` +
                                  `📅 当前状态:\n` +
                                  `   上次续期: ${renewInfo.lastRenewed}\n` +
                                  `   过期时间: ${renewInfo.expiry}`;
                    }
                    
                    finalScreenshot = afterVerifyShot;
                    await sendTelegramMessage(message, finalScreenshot);
                    
                } catch (e) {
                    console.error('获取续期信息失败:', e.message);
                    status = 'info_error';
                    message = `⚠️ *无法获取续期信息*\n用户: ${user.username}\n服务器: ${serverName}`;
                    finalScreenshot = afterVerifyShot;
                    await sendTelegramMessage(message, finalScreenshot);
                }

                // 关闭弹窗（如果有）
                try {
                    const closeBtn = page.getByRole('button', { name: /Cancel|Close|×/i }).first();
                    if (await closeBtn.isVisible({ timeout: 1000 })) {
                        await closeBtn.click();
                        await page.waitForTimeout(1000);
                    }
                } catch (e) {}

                // 返回服务器列表处理下一个
                await page.goto('https://dash.zampto.net/servers');
                await page.waitForTimeout(3000);
            }

            if (!renewInfo) {
                status = 'no_renew';
                message = `⚠️ *未执行续期操作*\n用户: ${user.username}\n原因: 没有找到可续期的服务器`;
                await sendTelegramMessage(message, serversOverviewShot);
            }

        } catch (err) {
            console.error(`处理用户时出错:`, err);
            status = 'error';
            message = `❌ *处理出错*\n用户: ${user.username}\n错误: ${err.message}`;
            
            try {
                finalScreenshot = await saveScreenshot(page, `${safeUser}_error.png`);
            } catch (e) {}
            
            await sendTelegramMessage(message, finalScreenshot);
        }

        // 最终截图
        try {
            const finalShot = await saveScreenshot(page, `${safeUser}_final_${status}.png`);
            console.log(`用户 ${user.username} 处理完成，状态: ${status}`);
        } catch (e) {
            console.log('最终截图失败');
        }
        
        console.log('---');
    }

    console.log('\n所有用户处理完成');
    
    try {
        await browser.close();
    } catch (e) {}
    
    process.exit(0);
})();
