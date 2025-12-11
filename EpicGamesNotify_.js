//name: Epic免费游戏领取提醒
//cron: 30 7 * * 5
// 每周五早上7:30执行，推送Epic本周免费游戏信息到钉钉群

const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 缓存文件路径（与脚本同目录）
const CACHE_FILE = path.join(__dirname, '.epic_games_cache.json');

/**
 * 读取上次推送的游戏列表缓存
 * @returns {{gameTitles: string[], lastPushTime: string} | null}
 */
function readCache() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const data = fs.readFileSync(CACHE_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.log('   ⚠️ 读取缓存失败:', e.message);
    }
    return null;
}

/**
 * 保存当前游戏列表到缓存
 * @param {string[]} gameTitles - 游戏标题列表
 */
function saveCache(gameTitles) {
    try {
        const cacheData = {
            gameTitles: gameTitles.sort(),
            lastPushTime: new Date().toISOString()
        };
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2), 'utf8');
        console.log('   💾 缓存已更新');
    } catch (e) {
        console.log('   ⚠️ 保存缓存失败:', e.message);
    }
}

/**
 * 检查游戏列表是否有变化
 * @param {Object} gamesData - 包含本周和下周游戏的对象
 * @returns {{changed: boolean, reason: string}}
 */
function checkIfGamesChanged(gamesData) {
    const { currentFreeGames, upcomingFreeGames } = gamesData;
    // 合并本周和下周的游戏标题进行对比
    const allTitles = [
        ...currentFreeGames.map(g => g.title),
        ...upcomingFreeGames.map(g => `[预告]${g.title}`)
    ].sort();
    
    const cache = readCache();
    
    if (!cache) {
        return { changed: true, reason: '首次运行，无缓存记录' };
    }
    
    const cachedTitles = cache.gameTitles || [];
    
    // 对比游戏列表
    if (allTitles.length !== cachedTitles.length) {
        return { changed: true, reason: `游戏数量变化: ${cachedTitles.length} → ${allTitles.length}` };
    }
    
    const currentSet = new Set(allTitles);
    const cachedSet = new Set(cachedTitles);
    
    // 找出新增的游戏
    const newGames = allTitles.filter(t => !cachedSet.has(t));
    // 找出移除的游戏
    const removedGames = cachedTitles.filter(t => !currentSet.has(t));
    
    if (newGames.length > 0 || removedGames.length > 0) {
        let reason = '游戏列表变化:';
        if (newGames.length > 0) reason += ` 新增[${newGames.join(', ')}]`;
        if (removedGames.length > 0) reason += ` 移除[${removedGames.join(', ')}]`;
        return { changed: true, reason };
    }
    
    return { 
        changed: false, 
        reason: `与上次相同 (上次推送: ${cache.lastPushTime})` 
    };
}

// 从环境变量获取钉钉Webhook配置
const DINGTALK_WEBHOOK = process.env.DINGTALK_ALERT_GROUP_WEBHOOK;
const DINGTALK_SECRET = process.env.DINGTALK_ALERT_GROUP_WEBHOOK_SECRET;

if (!DINGTALK_WEBHOOK) {
    console.error('❌ 未找到DINGTALK_ALERT_GROUP_WEBHOOK环境变量');
    console.error('请在青龙面板的环境变量中配置:');
    console.error('  DINGTALK_ALERT_GROUP_WEBHOOK=你的钉钉webhook地址');
    console.error('  DINGTALK_ALERT_GROUP_WEBHOOK_SECRET=你的钉钉webhook密钥(可选)');
    process.exit(1);
}

/**
 * 生成钉钉webhook签名
 * @param {string} secret - 密钥
 * @returns {{timestamp: number, sign: string}} - 时间戳和签名
 */
function generateSignature(secret) {
    const timestamp = Date.now();
    const stringToSign = `${timestamp}\n${secret}`;
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(stringToSign);
    const sign = encodeURIComponent(hmac.digest('base64'));
    return { timestamp, sign };
}

/**
 * 获取带签名的webhook URL
 * @returns {string} - 完整的webhook URL
 */
function getSignedWebhookUrl() {
    if (!DINGTALK_SECRET) {
        return DINGTALK_WEBHOOK;
    }
    const { timestamp, sign } = generateSignature(DINGTALK_SECRET);
    const separator = DINGTALK_WEBHOOK.includes('?') ? '&' : '?';
    return `${DINGTALK_WEBHOOK}${separator}timestamp=${timestamp}&sign=${sign}`;
}

// Epic API 地址列表（备用）
const EPIC_API_URLS = [
    'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions',
    'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions'
];

/**
 * 带重试的请求函数
 */
async function fetchWithRetry(urls, params, maxRetries = 2) {
    let lastError = null;
    
    for (const url of urls) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`   尝试请求: ${url.split('/').pop()} (第${attempt}次)`);
                const response = await axios.get(url, {
                    params,
                    timeout: 15000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'application/json',
                        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
                    }
                });
                return response;
            } catch (error) {
                lastError = error;
                console.log(`   ⚠️ 请求失败: ${error.message}`);
                if (attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, 1000)); // 等待1秒重试
                }
            }
        }
    }
    throw lastError;
}

async function getEpicFreeGames() {
    try {
        const params = {
            locale: 'zh-CN',
            country: 'CN',
            allowCountries: 'CN'
        };
        
        const response = await fetchWithRetry(EPIC_API_URLS, params);
        
        const elements = response.data?.data?.Catalog?.searchStore?.elements || [];
        const currentFreeGames = [];  // 本周免费
        const upcomingFreeGames = []; // 下周限免
        const now = new Date();
        
        // 格式化日期为北京时间的辅助函数
        const formatBeijingDate = (date) => {
            const beijingOffset = 8 * 60 * 60 * 1000; // UTC+8
            const beijingDate = new Date(date.getTime() + beijingOffset);
            return `${beijingDate.getUTCFullYear()}-${(beijingDate.getUTCMonth() + 1).toString().padStart(2, '0')}-` +
                `${beijingDate.getUTCDate().toString().padStart(2, '0')} ` +
                `${beijingDate.getUTCHours().toString().padStart(2, '0')}:${beijingDate.getUTCMinutes().toString().padStart(2, '0')}`;
        };
        
        // 构建游戏信息的辅助函数
        const buildGameInfo = (game, endDate, startDate = null) => {
            // 获取游戏图片
            let imageUrl = '';
            const keyImages = game.keyImages || [];
            // 按优先级查找图片（包含 VaultClosed 支持神秘游戏）
            const imageTypes = ['OfferImageWide', 'VaultClosed', 'DieselStoreFrontWide', 'Thumbnail', 'OfferImageTall'];
            for (const type of imageTypes) {
                const img = keyImages.find(i => i.type === type);
                if (img?.url) {
                    imageUrl = img.url;
                    break;
                }
            }
            
            // 获取原价格信息
            let originalPrice = '';
            try {
                const priceInfo = game.price?.totalPrice;
                if (priceInfo) {
                    const originalPriceValue = priceInfo.originalPrice || 0;
                    const currencyCode = priceInfo.currencyCode || 'CNY';
                    if (originalPriceValue > 0) {
                        if (currencyCode === 'CNY') {
                            originalPrice = `¥${(originalPriceValue / 100).toFixed(2)}`;
                        } else if (currencyCode === 'USD') {
                            originalPrice = `$${(originalPriceValue / 100).toFixed(2)}`;
                        } else {
                            originalPrice = `${(originalPriceValue / 100).toFixed(2)} ${currencyCode}`;
                        }
                    }
                }
            } catch (e) { /* 忽略 */ }
            
            // 获取游戏链接
            let gameUrl = '';
            // 检查是否是神秘游戏（没有具体页面）
            const isMysteryGame = game.title.toLowerCase().includes('mystery');
            
            if (game.catalogNs?.mappings?.length > 0) {
                gameUrl = `https://store.epicgames.com/zh-CN/p/${game.catalogNs.mappings[0].pageSlug}`;
            } else if (game.customAttributes?.length > 0) {
                const productSlugAttr = game.customAttributes.find(attr => attr.key === 'com.epicgames.app.productSlug');
                if (productSlugAttr) {
                    gameUrl = `https://store.epicgames.com/zh-CN/p/${productSlugAttr.value}`;
                }
            }
            
            // 神秘游戏或没有具体页面的，链接到免费游戏页面
            if (!gameUrl || isMysteryGame) {
                gameUrl = 'https://store.epicgames.com/zh-CN/free-games';
            }
            
            // 翻译神秘游戏标题为中文
            let displayTitle = game.title;
            if (isMysteryGame) {
                // Mystery Game 1 -> 神秘游戏 1
                displayTitle = game.title.replace(/Mystery Game/i, '神秘游戏');
            }
            
            const gameInfo = {
                title: displayTitle,  // 使用翻译后的标题
                url: gameUrl,
                image: imageUrl,
                originalPrice: originalPrice,
                endDate: formatBeijingDate(endDate)
            };
            
            if (startDate) {
                gameInfo.startDate = formatBeijingDate(startDate);
            }
            
            return gameInfo;
        };
        
        elements.forEach(game => {
            if (!game.promotions) return;
            
            const promotionalOffers = game.promotions.promotionalOffers || [];
            const upcomingOffers = game.promotions.upcomingPromotionalOffers || [];
            
            // 检查当前有效的免费促销
            let isCurrentFree = false;
            let currentEndDate = null;
            
            for (const offerSet of promotionalOffers) {
                for (const offer of offerSet.promotionalOffers) {
                    if (offer.discountSetting.discountPercentage === 0) {
                        const startDate = new Date(offer.startDate);
                        const endDateObj = new Date(offer.endDate);
                        if (now >= startDate && now <= endDateObj) {
                            isCurrentFree = true;
                            currentEndDate = endDateObj;
                            break;
                        }
                    }
                }
                if (isCurrentFree) break;
            }
            
            // 检查即将开始的促销（下周限免）
            let isUpcoming = false;
            let upcomingStartDate = null;
            let upcomingEndDate = null;
            
            if (!isCurrentFree) {
                for (const offerSet of upcomingOffers) {
                    for (const offer of offerSet.promotionalOffers) {
                        if (offer.discountSetting.discountPercentage === 0) {
                            const startDate = new Date(offer.startDate);
                            const endDateObj = new Date(offer.endDate);
                            // 未来7天内即将开始的免费游戏
                            if (startDate > now && startDate.getTime() - now.getTime() < 7 * 24 * 60 * 60 * 1000) {
                                isUpcoming = true;
                                upcomingStartDate = startDate;
                                upcomingEndDate = endDateObj;
                                break;
                            }
                        }
                    }
                    if (isUpcoming) break;
                }
            }
            
            // 添加到对应列表
            if (isCurrentFree) {
                currentFreeGames.push(buildGameInfo(game, currentEndDate));
            } else if (isUpcoming) {
                upcomingFreeGames.push(buildGameInfo(game, upcomingEndDate, upcomingStartDate));
            }
        });
        
        return { currentFreeGames, upcomingFreeGames };
    } catch (error) {
        console.error('获取EPIC游戏数据失败:', error.message);
        if (error.code) {
            console.error('   错误代码:', error.code);
        }
        if (error.response) {
            console.error('   HTTP状态:', error.response.status);
            console.error('   响应数据:', JSON.stringify(error.response.data).substring(0, 200));
        }
        console.error('\n💡 可能的解决方案:');
        console.error('   1. 检查网络连接是否正常');
        console.error('   2. 尝试使用代理或VPN');
        console.error('   3. Epic API 可能暂时不可用，稍后重试');
        throw error;
    }
}

/**
 * 发送钉钉通知
 * @param {Object} gamesData - 包含本周和下周游戏的对象
 */
async function sendDingtalkNotification(gamesData) {
    const { currentFreeGames, upcomingFreeGames } = gamesData;
    const totalGames = currentFreeGames.length + upcomingFreeGames.length;
    
    if (totalGames === 0) {
        console.log('本周和下周都没有免费游戏');
        return;
    }
    
    try {
        const title = `🎮 Epic免费游戏 (本周${currentFreeGames.length}款${upcomingFreeGames.length > 0 ? ` + 下周预告${upcomingFreeGames.length}款` : ''})`;
        
        let markdownContent = '';
        
        // 本周免费游戏
        if (currentFreeGames.length > 0) {
            markdownContent += `## 🎮 本周免费游戏\n\n`;
            markdownContent += `**共 ${currentFreeGames.length} 款游戏限时免费领取！**\n\n`;
            markdownContent += `---\n\n`;
            
            currentFreeGames.forEach((game, index) => {
                markdownContent += `### ${index + 1}. ${game.title}\n\n`;
                if (game.image) {
                    markdownContent += `![${game.title}](${game.image})\n\n`;
                }
                if (game.originalPrice) {
                    markdownContent += `💰 **原价**: ~~${game.originalPrice}~~ → **免费**\n\n`;
                }
                markdownContent += `⏳ **截止时间**: ${game.endDate}\n\n`;
                markdownContent += `🔗 **领取链接**: [点击领取](${game.url})\n\n`;
                if (index < currentFreeGames.length - 1) {
                    markdownContent += `---\n\n`;
                }
            });
        }
        
        // 下周限免预告
        if (upcomingFreeGames.length > 0) {
            markdownContent += `\n---\n\n`;
            markdownContent += `## 📅 下周限免预告\n\n`;
            markdownContent += `**共 ${upcomingFreeGames.length} 款游戏即将免费！**\n\n`;
            markdownContent += `---\n\n`;
            
            upcomingFreeGames.forEach((game, index) => {
                markdownContent += `### ${index + 1}. ${game.title}\n\n`;
                if (game.image) {
                    markdownContent += `![${game.title}](${game.image})\n\n`;
                }
                if (game.originalPrice) {
                    markdownContent += `💰 **原价**: ~~${game.originalPrice}~~ → **即将免费**\n\n`;
                }
                if (game.startDate) {
                    markdownContent += `🕐 **开始时间**: ${game.startDate}\n\n`;
                }
                markdownContent += `⏳ **截止时间**: ${game.endDate}\n\n`;
                markdownContent += `🔗 **商店页面**: [查看详情](${game.url})\n\n`;
                if (index < upcomingFreeGames.length - 1) {
                    markdownContent += `---\n\n`;
                }
            });
        }
        
        markdownContent += `\n---\n\n`;
        markdownContent += `📌 **快捷入口**: [Epic免费游戏页面](https://store.epicgames.com/free-games)\n\n`;
        markdownContent += `💡 *别忘了每周领取，游戏领取后永久拥有！*`;
        
        // 构建钉钉消息体
        const message = {
            msgtype: 'markdown',
            markdown: {
                title: title,
                text: markdownContent
            }
        };
        
        // 获取带签名的webhook URL
        const webhookUrl = getSignedWebhookUrl();
        
        // 发送钉钉通知
        const response = await axios.post(webhookUrl, message, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
        });
        
        if (response.data && response.data.errcode === 0) {
            console.log(`✅ 成功推送 ${totalGames} 款免费游戏通知到钉钉`);
            console.log(`   本周: ${currentFreeGames.map(g => g.title).join(', ') || '无'}`);
            if (upcomingFreeGames.length > 0) {
                console.log(`   下周预告: ${upcomingFreeGames.map(g => g.title).join(', ')}`);
            }
        } else {
            console.error('❌ 钉钉推送返回错误:', response.data);
        }
    } catch (error) {
        console.error('❌ 钉钉推送失败:', error.message);
        if (error.response) {
            console.error('钉钉响应数据:', error.response.data);
        }
    }
}

async function main() {
    try {
        console.log('='.repeat(50));
        console.log('🚀 Epic免费游戏领取提醒 - 钉钉推送版');
        console.log('='.repeat(50));
        console.log('');
        console.log('📡 开始获取Epic免费游戏信息...');
        
        const gamesData = await getEpicFreeGames();
        const { currentFreeGames, upcomingFreeGames } = gamesData;
        
        // 打印本周免费游戏
        console.log(`\n🎮 本周免费游戏 (${currentFreeGames.length} 款):`);
        console.log('-'.repeat(40));
        if (currentFreeGames.length > 0) {
            currentFreeGames.forEach((game, index) => {
                console.log(`${index + 1}. ${game.title}`);
                if (game.originalPrice) console.log(`   💰 原价: ${game.originalPrice} → 免费`);
                console.log(`   ⏳ 截止: ${game.endDate}`);
                console.log(`   🔗 ${game.url}`);
                if (game.image) console.log(`   🖼️ 图片: ${game.image.substring(0, 50)}...`);
                console.log('');
            });
        } else {
            console.log('   暂无本周免费游戏');
            console.log('');
        }
        
        // 打印下周限免预告
        console.log(`📅 下周限免预告 (${upcomingFreeGames.length} 款):`);
        console。log('-'。repeat(40));
        if (upcomingFreeGames。length > 0) {
            upcomingFreeGames.forEach((game, index) => {
                console。log(`${index + 1}。 ${game。title}`);
                if (game.originalPrice) console.log(`   💰 原价: ${game.originalPrice} → 即将免费`);
                if (game.startDate) console.log(`   🕐 开始: ${game.startDate}`);
                console.log(`   ⏳ 截止: ${game。endDate}`);
                console.log(`   🔗 ${game。url}`);
                if (game.image) console.log(`   🖼️ 图片: ${game.image.substring(0, 50)}...`);
                console.log('');
            });
        } else {
            console.log('   暂无下周限免预告');
            console.log('');
        }
        
        console。log('-'。repeat(40));
        
        // 检查游戏列表是否有变化
        console。log('🔍 检查内容变化...');
        const { changed, reason } = checkIfGamesChanged(gamesData);
        console。log(`   ${reason}`);
        
        if (!changed) {
            console.log('');
            console.log('💤 游戏列表未变化，跳过本次推送');
            console.log('');
            console.log('='.repeat(50));
            console.log('✅ 脚本执行完成（无需推送）');
            console。log('='。repeat(50));
            return;
        }
        
        console。log('');
        console。log('📤 正在推送到钉钉...');
        await sendDingtalkNotification(gamesData);
        
        // 推送成功后更新缓存（包含本周和下周的标题）
        const allTitles = [
            ...currentFreeGames。map(g => g.title)，
            ...upcomingFreeGames。map(g => `[预告]${g。title}`)
        ];
        saveCache(allTitles);
        
        console.log('');
        console.log('='.repeat(50));
        console.log('✅ 脚本执行完成');
        console。log('='。repeat(50));
    } catch (error) {
        console.error('❌ 脚本执行失败:', error.message);
        process。exit(1);
    }
}

main();
