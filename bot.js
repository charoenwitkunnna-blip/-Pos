const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// --- YOUR SCRIPT INJECTED HERE ---
// We removed the HUD since nobody is looking at the screen in the cloud.
const BOT_INJECTION = `
(function() {
    window.myLiveGameState = null;
    window.myEntitiesMap = null;
    window.myEntitiesArray = null;

    console.log("[Bot Core] Injected before load!");

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

    // Command Listener
    setInterval(() => {
        const chatContainer = document.querySelector('.ChatMessages');
        if (chatContainer && !window.chatObserverAttached) {
            window.chatObserverAttached = true;
            new MutationObserver(mutations => {
                mutations.forEach(mutation => {
                    mutation.addedNodes.forEach(node => {
                        if (node.classList && node.classList.contains('MessageWrapper')) {
                            const fullMsg = node.innerText || node.textContent;
                            console.log("[GAME CHAT] " + fullMsg); // Pipes to GitHub Actions logs
                            
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

(async () => {
    // 1. Launch the headless browser (optimized for WebGL in the cloud)
    const browser = await puppeteer.launch({
        headless: 'new',
        args:[
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--use-gl=egl', // Crucial for WebGL games
            '--mute-audio',
            '--window-size=1280,720'
        ]
    });

    const page = await browser.newPage();

    // 2. Pipe browser console to Node terminal (so you can see chat in GitHub Actions)
    page.on('console', msg => {
        if(msg.text().includes('[Bot]') || msg.text().includes('[GAME CHAT]')) {
            console.log(msg.text());
        }
    });

    // 3. Inject the Tampermonkey script BEFORE the page loads
    await page.evaluateOnNewDocument(BOT_INJECTION);

    // 4. Change URL to the specific lobby/room you want the bot in
    console.log("Navigating to game...");
    await page.goto('https://bloxd.io/?lobby=survival&room=your_room_name_here', { waitUntil: 'networkidle2' });

    // 5. Auto-Login Logic (Bloxd requires typing a name and clicking "Play")
    try {
        console.log("Waiting for Login menu...");
        
        // Wait for the name input box (Adjust selector if Bloxd updates)
        await page.waitForSelector('input[type="text"]', { timeout: 30000 });
        
        // Type the bot's name
        await page.type('input[type="text"]', 'GitHub_Bot_01');
        
        // Find and click the play button (often a big button with text "Play" or similar)
        // We use evaluate to easily find the button by its text content
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const playBtn = buttons.find(b => b.innerText.includes('Play') || b.innerText.includes('Join'));
            if (playBtn) playBtn.click();
        });

        console.log("Successfully clicked Play. Bot should be connected now!");
    } catch (err) {
        console.log("Auto-login failed or wasn't needed. Error: ", err.message);
    }

    console.log("Bot is online! Will keep process alive for 6 hours...");
    
    // 6. Keep the script running forever (GitHub Actions will kill it after 6 hours)
    await new Promise(() => {}); 
})();
