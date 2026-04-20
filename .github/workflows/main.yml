from seleniumbase import SB
import base64
import requests
import os
import time

CHAPTER_URL = "https://manhuaus.com/manga/infinite-mage/chapter-122/"

print(f"Bypassing Cloudflare for: {CHAPTER_URL}")

image_urls =[]

# 1. Use SeleniumBase Context Manager
# uc=True applies the Undetected Chrome patches
# xvfb=True creates the virtual monitor so Cloudflare doesn't flag you as headless
with SB(uc=True, xvfb=True, test=True, locale_code="en") as sb:
    
    # uc_open_with_reconnect temporarily disconnects WebDriver from Chrome
    # This prevents Cloudflare from seeing the bot while the page initially loads
    sb.uc_open_with_reconnect(CHAPTER_URL, reconnect_time=6)
    
    print("Waiting for page to settle...")
    sb.sleep(5)
    
    try:
        # This is SeleniumBase's magic method that uses PyAutoGUI to physically 
        # move the mouse and click the Turnstile checkbox if it exists.
        sb.uc_gui_click_captcha()
        print("Captcha click attempted.")
        sb.sleep(5)
    except Exception as e:
        print("No Captcha click needed or failed (Continuing...)")

    print("Taking debug screenshot...")
    # This will be uploaded to GitHub artifacts so you can see exactly what happened
    sb.save_screenshot("debug_screenshot.png")
    print("Screenshot saved!")

    # 2. Extract Image URLs
    images = sb.find_elements("css selector", ".wp-manga-chapter-img")
    
    for img in images:
        src = img.get_attribute("data-src") or img.get_attribute("src")
        if src:
            image_urls.append(src.strip())
            
    print(f"Found {len(image_urls)} images.")
    
# CRITICAL: Exiting the 'with SB' block automatically closes the browser 
# and frees up the 2GB+ of RAM so Ollama has enough memory to run!

if len(image_urls) == 0:
    print("CRITICAL: Still couldn't find images. Check 'debug_screenshot.png' in the GitHub Action Artifacts.")
    exit(1)

# 3. Process Images with Local AI (Ollama)
target_indices =[0, 1, 2, len(image_urls)//2, len(image_urls)-3, len(image_urls)-2, len(image_urls)-1]
scene_descriptions =[]

headers = {
    "Referer": "https://manhuaus.com/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
}

for idx in target_indices:
    if idx >= len(image_urls): continue
    
    img_url = image_urls[idx]
    print(f"Downloading image {idx+1}/{len(image_urls)}...")
    
    try:
        img_response = requests.get(img_url, headers=headers)
        if img_response.status_code != 200:
            print(f"Failed to download image {idx+1}. Status: {img_response.status_code}")
            continue

        encoded_string = base64.b64encode(img_response.content).decode('utf-8')
        print(f"Sending image {idx+1} to local AI (Moondream)...")
        
        payload = {
            "model": "moondream",
            "prompt": "This is a panel from a fantasy manhwa. Describe the setting, the characters, and what is happening in this specific scene.",
            "images": [encoded_string],
            "stream": False
        }
        
        ai_response = requests.post("http://localhost:11434/api/generate", json=payload)
        
        if ai_response.status_code == 200:
            description = ai_response.json().get('response', '')
            scene_descriptions.append(f"- **Scene {idx+1}:** {description}")
        else:
            print(f"AI Error on image {idx+1}")
            
    except Exception as e:
        print(f"Error processing image {idx+1}: {e}")

# 4. Save the Recap to your Repo
if scene_descriptions:
    print("Combining scenes into final recap...")
    final_recap = "\n".join(scene_descriptions)

    os.makedirs("recaps", exist_ok=True)
    filename = "recaps/infinite_mage_chapter_122.md"

    with open(filename, "w") as f:
        f.write(f"# Infinite Mage - Chapter 122 Recap\n\n")
        f.write(f"### Scene Breakdown:\n")
        f.write(final_recap)

    print(f"Success! Saved to {filename}")
