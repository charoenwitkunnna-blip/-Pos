const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const FormData = require('form-data');
puppeteer.use(StealthPlugin());

const BOT_INJECTION = `
(function() {
    window.myLiveGameState = null;
    window.myEntitiesMap = null;
    window.myEntitiesArray = null;

    console.log("[Bot Core] Injected before load!");

    // --- 1. GAME DATA HOOKS ---
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
        const players = [];
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

    // --- 2. MESSAGE QUEUE ---
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

    // --- 3. CHAT LISTENER ---
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

    // --- 4. AUTO-RECONNECT (TRY AGAIN) WATCHER ---
    setInterval(() => {
        // Look for the specific Try Again button using its unique classes
        const tryAgainButtons = document.querySelectorAll('.PromptPopupNotificationBodyPrimaryButton');
        
        tryAgainButtons.forEach(btn => {
            // Double check that it actually says "Try Again" just to be safe
            if (btn.innerText && btn.innerText.includes('Try Again')) {
                console.log("[Bot System] Disconnect detected! Clicking 'Try Again' button...");
                
                // Click it via standard click and simulated mouse events for React compatibility
                btn.click();
                btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            }
        });
    }, 2000); // Checks the screen every 2 seconds

})();
`;

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

    // Route browser logs to GitHub Actions terminal
    page.on('console', msg => {
        if(msg.text().includes('[Bot]') || msg.text().includes('[GAME CHAT]') || msg.text().includes('[Bot System]')) {
            console.log(msg.text());
        }
    });

   console.log("Navigating to game...");
    await page.goto('https://bloxd.io/play/classic/%F0%9F%A9%B8%F0%9F%A9%B8lifesteal%F0%9F%98%88', { waitUntil: 'networkidle2' });

    // ==========================================
    // CLOUDFLARE TURNSTILE CAPTCHA SOLVER
    // ==========================================
    try {
        console.log("Checking for Cloudflare 'Verify you are human' CAPTCHA...");
        
        // Wait up to 10 seconds for the Turnstile iframe to appear
        const cfIframe = await page.waitForSelector('iframe[src*="cloudflare"]', { timeout: 10000 });
        
        if (cfIframe) {
            console.log("[Bot System] CAPTCHA detected! Calculating coordinates...");
            
            // Get the exact X, Y bounding box of the iframe on the virtual screen
            const box = await cfIframe.boundingBox();
            
            if (box) {
                // The Turnstile checkbox is generally 30-40 pixels from the left edge 
                // and vertically centered inside the iframe.
                const targetX = box.x + 40; 
                const targetY = box.y + (box.height / 2);

                console.log(`[Bot System] Moving mouse to X:${targetX}, Y:${targetY}`);

                // 1. Move mouse smoothly over 25 steps to simulate human hand movement
                await page.mouse.move(targetX, targetY, { steps: 25 });
                
                // 2. Pause for a random fraction of a second
                await new Promise(r => setTimeout(r, Math.random() * 400 + 200));
                
                // 3. Perform a human click (mouse down, slight delay, mouse up)
                await page.mouse.down();
                await new Promise(r => setTimeout(r, Math.random() * 50 + 50));
                await page.mouse.up();
                
                console.log("[Bot System] Clicked! Waiting for CAPTCHA to resolve...");
                await new Promise(r => setTimeout(r, 6000)); // Give it 6 seconds to verify and fade out
            }
        }
    } catch (err) {
        // If it times out, it means the CAPTCHA didn't pop up (which is good!)
        console.log("[Bot System] No CAPTCHA detected. Proceeding...");
    }

    // ==========================================
    // Login automation
    // ==========================================
    try {
        console.log("Waiting for Login menu...");
        
        await page.waitForSelector('input[type="text"]', { timeout: 30000 });
        
        await page.type('input[type="text"]', 'GitHub_Bot_01');
        
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const playBtn = buttons.find(b => b.innerText.includes('Play') || b.innerText.includes('Join'));
            if (playBtn) playBtn.click();
        });

        console.log("Successfully clicked Play. Bot should be connected now!");
    } catch (err) {
        console.log("Auto-login error (might already be bypassed): ", err.message);
    }

    console.log("Bot is online! Starting screenshot loop...");

    // Screenshot sender loop (Every 10 seconds)
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
            console.log("[System] Screenshot error: ", err.message);
        }
    }, 10000); 

    // Keep the Node process running
    await new Promise(() => {}); 
})();
