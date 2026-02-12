const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

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

// 检查是否登录成功
async function checkLoginSuccess(page) {
    const blockedTexts = ['Access Blocked', 'VPN', 'Proxy Detected', 'blocked', 'access denied'];
    const pageContent = await page.content().catch(() => '');
    
    for (const text of blockedTexts) {
        if (pageContent.toLowerCase().includes(text.toLowerCase())) {
            return { success: false, reason: 'access_blocked', message: '检测到 VPN/代理被拦截' };
        }
    }
    
    const url = page.url();
    if (url.includes('sign-in') || url.includes('login') || url.includes('auth')) {
        const errorSelectors = ['.error', '.alert', '[role="alert"]', '.text-danger', '.text-red'];
        for (const selector of errorSelectors) {
            try {
                const errorEl = page.locator(selector).first();
                if (await errorEl.isVisible({ timeout: 1000 })) {
                    const errorText = await errorEl.innerText();
                    if (errorText && errorText.length > 0) {
                        return { success: false, reason: 'login_error', message: errorText };
                    }
                }
            } catch (e) {}
        }
        return { success: false, reason: 'still_on_login_page', message: '仍在登录页面' };
    }
    
    const successIndicators = ['Servers Overview', 'Dashboard', 'Manage Server', 'Create Server', 'homepage', 'dash.zampto'];
    for (const indicator of successIndicators) {
        if (pageContent.toLowerCase().includes(indicator.toLowerCase()) || url.toLowerCase().includes(indicator.toLowerCase())) {
            return { success: true };
        }
    }
    
    try {
        const userMenu = page.locator('[class*="user"], [class*="account"], [class*="profile"]').first();
        if (await userMenu.isVisible({ timeout: 1000 })) {
            return { success: true };
        }
    } catch (e) {}
    
    return { success: false, reason: 'unknown', message: '无法确定登录状态' };
}

// 处理 Turnstile 验证
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
        const turnstileData = await turnstileFrame.evaluate(() => window.__turnstile_data).catch(() => null);
        
        if (turnstileData && turnstileData.found) {
            const iframeElement = await turnstileFrame.frameElement();
            const box = await iframeElement.boundingBox();
            
            if (box) {
                const clickX = box.x + (box.width * turnstileData.xRatio);
                const clickY = box.y + (box.height * turnstileData.yRatio);
                
                console.log(`[${contextName}] 点击坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
                
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
            console.log(`[${contextName}] 使用备用方法：点击中心`);
            const iframeElement = await turnstileFrame.frameElement();
            const box = await iframeElement.boundingBox();
            if (box) {
                await page.mouse.click(box.x + box.width/2, box.y + box.height/2);
            }
        }
        
        await page.waitForTimeout(3000);
        
        for (let i = 0; i < 10; i++) {
            try {
                const verified = await turnstileFrame.evaluate(() => {
                    const checkbox = document.querySelector('input[type="checkbox"]');
                    return checkbox ? checkbox.checked : false;
                }).catch(() => false);
                
                if (verified) {
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

    console.log('启动浏览器...');
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    console.log('浏览器启动成功');

    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 }
    });
    
    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    await page.addInitScript(INJECTED_SCRIPT);
    console.log('注入脚本已添加');

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const safeUser = getSafeUsername(user.username);
        console.log(`\n=== 用户 ${i + 1}/${users.length}: ${user.username} ===`);
        
        let status = 'unknown';
        let message = '';
        let finalScreenshot = null;
        let renewInfo = null;

        try {
            console.log('导航到 Zampto 登录页...');
            await page.goto('https://auth.zampto.net/sign-in');
            await page.waitForTimeout(2000);
            
            const loginInitShot = await saveScreenshot(page, `${safeUser}_01_login_init.png`);
            await sendTelegramMessage(`🔄 开始处理用户: ${user.username}\n步骤: 进入登录页`, loginInitShot);

            console.log('输入邮箱...');
            const emailInput = page.locator('input[type="text"], input[type="email"]').first();
            await emailInput.waitFor({ state: 'visible', timeout: 10000 });
            await emailInput.fill(user.username);
            await page.waitForTimeout(500);

            const emailFilledShot = await saveScreenshot(page, `${safeUser}_02_email_filled.png`);

            console.log('点击登录按钮...');
            await page.getByRole('button', { name: /登录|Login|Sign in/i }).click();
            await page.waitForTimeout(3000);
            
            const passwordPageShot = await saveScreenshot(page, `${safeUser}_03_password_page.png`);

            console.log('输入密码...');
            const pwdInput = page.locator('input[type="password"]').first();
            await pwdInput.waitFor({ state: 'visible', timeout: 10000 });
            await pwdInput.fill(user.password);
            await page.waitForTimeout(500);

            const pwdFilledShot = await saveScreenshot(page, `${safeUser}_04_pwd_filled.png`);

            console.log('点击继续按钮...');
            await page.getByRole('button', { name: /继续|Continue/i }).click();
            await page.waitForTimeout(4000);
            
            const afterLoginShot = await saveScreenshot(page, `${safeUser}_05_after_login.png`);

            console.log('检查登录状态...');
            const loginCheck = await checkLoginSuccess(page);
            
            if (!loginCheck.success) {
                console.error(`❌ 登录失败: ${loginCheck.message}`);
                status = 'login_failed';
                message = `❌ *登录失败*\n用户: ${user.username}\n原因: ${loginCheck.message}`;
                finalScreenshot = afterLoginShot;
                
                await sendTelegramMessage(message, finalScreenshot);
                continue;
            }

            console.log('✅ 登录成功，当前 URL:', page.url());
            await sendTelegramMessage(`✅ 用户 ${user.username} 登录成功\nURL: ${page.url()}`, afterLoginShot);

            console.log('点击 Servers Overview...');
            try {
                await page.getByRole('link', { name: /Servers Overview/i }).click();
            } catch (e) {
                await page.locator('text=Servers Overview').first().click();
            }
            
            await page.waitForTimeout(3000);
            const serversOverviewShot = await saveScreenshot(page, `${safeUser}_06_servers_overview.png`);

            console.log('获取服务器列表...');
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

            for (let serverIdx = 0; serverIdx < manageButtons.length; serverIdx++) {
                console.log(`\n--- 处理第 ${serverIdx + 1}/${manageButtons.length} 个服务器 ---`);
                
                const currentButtons = await page.getByRole('button', { name: /Manage Server/i }).all();
                if (serverIdx >= currentButtons.length) break;
                
                const btn = currentButtons[serverIdx];
                
                let serverName = 'Unknown';
                try {
                    const card = await btn.locator('..').locator('..').locator('..');
                    const titleEl = await card.locator('h3, h4, .title, [class*="name"]').first();
                    if (await titleEl.isVisible({ timeout: 1000 })) {
                        serverName = await titleEl.innerText();
                    }
                } catch (e) {
                    serverName = `Server-${serverIdx + 1}`;
                }
                
                console.log(`服务器名称: ${serverName}`);
                
                await btn.click();
                console.log('✅ 已点击 Manage Server');
                
                await page.waitForTimeout(3000);
                const serverDetailShot = await saveScreenshot(page, `${safeUser}_07_server_${serverIdx + 1}_detail.png`);

                console.log('查找 Renew Server 按钮...');
                
                let renewBtn = null;
                try {
                    renewBtn = page.getByRole('button', { name: /Renew Server/i });
                    await renewBtn.waitFor({ state: 'visible', timeout: 5000 });
                } catch (e) {
                    console.log('未找到 Renew Server 按钮');
                    await page.goBack();
                    await page.waitForTimeout(2000);
                    continue;
                }

                let beforeRenewInfo = {};
                try {
                    const renewSection = page.locator('div:has-text("Renew"), div:has-text("Server last renewed")').first();
                    const infoText = await renewSection.innerText({ timeout: 3000 });
                    const lastRenewedMatch = infoText.match(/Server last renewed:\s*(.+)/i);
                    const expiryMatch = infoText.match(/Expiry.*?:(.+)/i);
                    
                    beforeRenewInfo = {
                        lastRenewed: lastRenewedMatch ? lastRenewedMatch[1].trim() : 'Unknown',
                        expiry: expiryMatch ? expiryMatch[1].trim() : 'Unknown'
                    };
                } catch (e) {}

                await renewBtn.click();
                console.log('✅ 已点击 Renew Server');
                
                await page.waitForTimeout(2000);
                const renewModalShot = await saveScreenshot(page, `${safeUser}_08_renew_modal.png`);

                console.log('处理人机验证...');
                await page.waitForTimeout(2000);
                
                const turnstileResult = await handleTurnstile(page, 'Renew-Modal');
                
                if (!turnstileResult.success) {
                    console.log('⚠️ Turnstile 可能未通过，继续等待...');
                }
                
                await page.waitForTimeout(5000);
                const afterVerifyShot = await saveScreenshot(page, `${safeUser}_09_after_verify.png`);

                console.log('获取续期后信息...');
                await page.waitForTimeout(3000);
                
                try {
                    const renewSection = page.locator('div:has-text("Renew"), div:has-text("Server last renewed")').first();
                    const infoText = await renewSection.innerText({ timeout: 5000 });
                    const lastRenewedMatch = infoText.match(/Server last renewed:\s*(.+)/i);
                    const expiryMatch = infoText.match(/Expiry.*?:(.+)/i);
                    
                    renewInfo = {
                        serverName: serverName,
                        lastRenewed: lastRenewedMatch ? lastRenewedMatch[1].trim() : 'Unknown',
                        expiry: expiryMatch ? expiryMatch[1].trim() : 'Unknown',
                        beforeLastRenewed: beforeRenewInfo.lastRenewed,
                        beforeExpiry: beforeRenewInfo.expiry
                    };
                    
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

                try {
                    const closeBtn = page.getByRole('button', { name: /Cancel|Close|×/i }).first();
                    if (await closeBtn.isVisible({ timeout: 1000 })) {
                        await closeBtn.click();
                        await page.waitForTimeout(1000);
                    }
                } catch (e) {}

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
