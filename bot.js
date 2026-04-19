const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const FormData = require('form-data');
puppeteer.use(StealthPlugin());

// ==========================================
// 1. THE BOT'S BRAIN (Game Data & Chat Only)
// ==========================================
const BOT_INJECTION = `
(function() {
    window.myLiveGameState = null;
    window.myEntitiesMap = null;
    window.myEntitiesArray = null;

    console.log("[Bot Core] Injected before load!");

    // Game Data Hooks
    const bkpDefineProperty = Object.defineProperty;
    Object.defineProperty = function(obj, prop, descriptor) {
        if (prop === 'patch' && descriptor && typeof descriptor.value === 'function') {
            const originalPatch = descriptor.value;
            descriptor.value = function() {
                const result = originalPatch.apply(this, arguments);
                if (this.getState && this.getState().entities) {
                    window.myLiveGameState = this.getState();
                } else if (this.entities) {
                    window.myLiveGameState = this;
                }
                return result;
            };
        }
        if (prop === 'entities' && descriptor && typeof descriptor.set === 'function') {
            const originalSet = descriptor.set;
            descriptor.set = function(val) {
                window.myLiveGameState = this;
                return originalSet.call(this, val);
            };
        }
        return bkpDefineProperty.apply(this, arguments);
    };

    const bkpMapSet = Map.prototype.set;
    Map.prototype.set = function(key, value) {
        if (value && typeof value === 'object') {
            if (value.type === 'Player' || ('name' in value && 'x' in value && 'y' in value && 'z' in value)) {
                window.myEntitiesMap = this;
            }
        }
        return bkpMapSet.call(this, key, value);
    };

    function getPlayers() {
        const players =[];
        let items =[];
        if (window.myLiveGameState && window.myLiveGameState.entities) {
            const entities = window.myLiveGameState.entities;
            items = entities.$items ? Object.values(entities.$items) : 
                    (typeof entities.values === 'function' ? Array.from(entities.values()) : Object.values(entities));
        } else if (window.myEntitiesMap) {
            items = Array.from(window.myEntitiesMap.values());
        }
        items.forEach(ent => {
            if (!ent) return;
            if (ent.type === 'Player' || (ent.name && ent.x !== undefined && ent.y !== undefined && ent.z !== undefined)) {
                players.push({
                    name: String(ent.name || "Unknown").trim(),
                    x: Number(ent.x || 0), y: Number(ent.y || 0), z: Number(ent.z || 0)
                });
            }
        });
        return players;
    }

    // Message Queue
    const messageQueue =[];
    let isProcessingQueue = false;

    async function processQueue() {
        if (messageQueue.length === 0) {
            isProcessingQueue = false;
            return;
        }
        isProcessingQueue = true;
        const message = messageQueue.shift();

        const input = document.querySelector('.ChatInput');
        if (!input) {
            messageQueue.unshift(message);
            setTimeout(processQueue, 1000);
            return;
        }

        input.focus();
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        if (nativeSetter) nativeSetter.call(input, message);
        else input.value = message;

        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 150));

        const enterDown = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true });
        const enterUp = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true });
        input.dispatchEvent(enterDown);
        input.dispatchEvent(enterUp);

        console.log("[ChatBot] Sent: " + message);
        setTimeout(processQueue, 3000);
    }

    function addMessageToQueue(message) {
        messageQueue.push(message);
        if (!isProcessingQueue) processQueue();
    }

    // Chat Listener
    setInterval(() => {
        const chatContainer = document.querySelector('.ChatMessages');
        if (chatContainer && !window.chatObserverAttached) {
            window.chatObserverAttached = true;
            new MutationObserver(mutations => {
                mutations.forEach(mutation => {
                    mutation.addedNodes.forEach(node => {
                        if (node.classList && node.classList.contains('MessageWrapper')) {
                            const fullMsg = node.innerText || node.textContent;
                            console.log("[GAME CHAT] " + fullMsg); 
                            
                            const splitIndex = fullMsg.indexOf(': ');
                            if (splitIndex !== -1) {
                                const msgBody = fullMsg.substring(splitIndex + 2).trim();
                                if (msgBody.toLowerCase().startsWith('!pos ')) {
                                    const targetName = msgBody.substring(5).trim().toLowerCase();
                                    const players = getPlayers();
                                    const target = players.find(p => p.name.toLowerCase().includes(targetName));
                                    
                                    if (target) {
                                        addMessageToQueue(\`\${target.name} is at[\${target.x.toFixed(0)}, \${target.y.toFixed(0)}, \${target.z.toFixed(0)}]\`);
                                    } else {
                                        addMessageToQueue(\`Could not find player: \${targetName}\`);
                                    }
                                }
                            }
                        }
                    });
                });
            }).observe(chatContainer, { childList: true });
            console.log("[Bot] Chat listener attached!");
        }
    }, 2000);
})();
`;

// ==========================================
// 2. PUPPETEER HEADLESS LAUNCHER
// ==========================================
(async () => {
    const browser = await puppeteer.launch({
        headless: 'new',
        args:[
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--use-gl=egl',
            '--mute-audio',
            '--window-size=1280,720'
        ]
    });

    const page = await browser.newPage();

    page.on('console', msg => {
        if(msg.text().includes('[Bot]') || msg.text().includes('[GAME CHAT]') || msg.text().includes('[Bot System]')) {
            console.log(msg.text());
        }
    });

    await page.evaluateOnNewDocument(BOT_INJECTION);

    console.log("Navigating to game...");
    await page.goto('https://bloxd.io/play/classic/%F0%9F%A9%B8%F0%9F%A9%B8lifesteal%F0%9F%98%88', { waitUntil: 'networkidle2' });

    // ==========================================
    // 3. MASTER SCREEN-STATE LOOP (Runs every 2s)
    // ==========================================
    setInterval(async () => {
        try {
            // Evaluate what is currently visible on the screen
            const state = await page.evaluate(() => {
                
                // State 1: Is there a Captcha? (Searches for ALL iframes just to be safe)
                const iframes = Array.from(document.querySelectorAll('iframe'));
                // Turnstile often uses src containing challenges.cloudflare.com
                const cfIframe = iframes.find(f => f.src.includes('cloudflare') || f.src.includes('turnstile'));
                
                // Fallback: If text "Human or Iron Watermelon??" is on screen, there is a captcha.
                const hasCaptchaText = document.body.innerText.includes("Human or Iron Watermelon");

                if (cfIframe && cfIframe.getBoundingClientRect().width > 0) {
                    return { action: 'captcha', rect: cfIframe.getBoundingClientRect() };
                }
                // If we see the text but couldn't identify the iframe by URL, just grab the first visible iframe
                if (hasCaptchaText && iframes.length > 0) {
                    const visibleIframe = iframes.find(f => f.getBoundingClientRect().width > 0);
                    if (visibleIframe) return { action: 'captcha', rect: visibleIframe.getBoundingClientRect() };
                }

                // State 2: Is the "Try Again" button visible?
                const allButtons = Array.from(document.querySelectorAll('div[role="button"], button'));
                const tryAgainBtn = allButtons.find(btn => btn.innerText && btn.innerText.includes('Try Again'));
                if (tryAgainBtn && tryAgainBtn.getBoundingClientRect().width > 0) {
                    return { action: 'reconnect' };
                }

                // State 3: Is the "Play" (Login) button visible?
                const nameInput = document.querySelector('input[type="text"]');
                const playBtn = allButtons.find(btn => btn.innerText && (btn.innerText.includes('Play') || btn.innerText.includes('Join')));
                if (nameInput && playBtn && playBtn.getBoundingClientRect().width > 0) {
                    return { action: 'login' };
                }

                return { action: 'idle' };
            });

            // EXECUTE ACTIONS BASED ON STATE
            if (state.action === 'login') {
                console.log("[Bot System] Found Login Screen. Entering name...");
                await page.type('input[type="text"]', 'GitHub_Bot_01');
                await page.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('div[role="button"], button'));
                    const playBtn = btns.find(b => b.innerText && (b.innerText.includes('Play') || b.innerText.includes('Join')));
                    if (playBtn) playBtn.click();
                });
                console.log("[Bot System] Clicked Play!");
            }
            else if (state.action === 'reconnect') {
                console.log("[Bot System] Disconnect detected. Clicking 'Try Again'...");
                await page.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('div[role="button"], button'));
                    const tryAgainBtn = btns.find(b => b.innerText && b.innerText.includes('Try Again'));
                    if (tryAgainBtn) tryAgainBtn.click();
                });
            }
            else if (state.action === 'captcha') {
                console.log("[Bot System] CAPTCHA detected! Taking control of mouse...");
                const rect = state.rect;
                
                // Calculate box target coords
                const targetX = rect.x + 40; 
                const targetY = rect.y + (rect.height / 2);

                // Simulate human mouse movements
                await page.mouse.move(targetX, targetY, { steps: 25 });
                await new Promise(r => setTimeout(r, Math.random() * 400 + 200));
                
                await page.mouse.down();
                await new Promise(r => setTimeout(r, Math.random() * 50 + 50));
                await page.mouse.up();
                
                console.log("[Bot System] Solved CAPTCHA! Waiting for it to disappear...");
                // Pause the loop for 6 seconds so it doesn't double-click
                await new Promise(r => setTimeout(r, 6000));
            }

        } catch (err) {
            // Ignore temporary errors when navigating
        }
    }, 2500); // Master loop runs every 2.5 seconds


    // ==========================================
    // 4. DISCORD SCREENSHOT LOOP (Every 10s)
    // ==========================================
    setInterval(async () => {
        try {
            const imageBuffer = await page.screenshot({ type: 'jpeg', quality: 50 });
            
            const webhookUrl = process.env.DISCORD_WEBHOOK;
            if (webhookUrl) {
                const form = new FormData();
                form.append('file', imageBuffer, 'screenshot.jpg');
                
                await axios.post(webhookUrl, form, {
                    headers: form.getHeaders()
                });
            }
        } catch(err) {
            // Ignoring screenshot errors
        }
    }, 10000); 

})();
