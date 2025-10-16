// seeker_worker.js (標準Web Worker)

// --- Global Data (Worker Scope) ---
let gachaData;
let itemMaster;

// --- Utility Functions ---

/**
 * Xorshift32のシード更新関数
 */
function xorshift32(seed) {
    let x = seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 15;
    return x >>> 0; // 符号なし32ビット整数として返す
}

/**
 * 1回分のガチャシミュレーションを実行
 */
function advanceOneStep(currentSeed) { // lastItemIdは、このシンプルなロジックでは未使用
    const gacha = gachaData;
    
    // 1. シード更新 (S1)
    const s1 = xorshift32(currentSeed);

    // 2. 目玉アイテム判定
    if ((s1 % 10000) < gacha.featuredItemRate) {
        return { drawnItemId: -1, endSeed: s1 }; // 目玉アイテムID: -1
    }

    // 3. レアリティ判定 (S2)
    const s2 = xorshift32(s1);
    const rarityVal = s2 % 10000;
    let rarityId = -1; // 0, 1, 2, 3, 4のいずれか
    
    // 累積排出率をチェック
    for (let i = 0; i < gacha.cumulativeRarityRates.length; i++) {
        if (rarityVal < gacha.cumulativeRarityRates[i]) {
            rarityId = i;
            break;
        }
    }
    
    // 4. アイテム排出 (S3)
    // 検索ロジック修正: rarityIdが有効かチェック
    if (rarityId === -1) {
        // 累積確率の計算に問題がある場合に備えて、シードを進める
        const s3 = xorshift32(s2);
        return { drawnItemId: 999, endSeed: s3 }; 
    }
    
    const itemPool = gacha.rarityItems[rarityId.toString()]; 
    if (!itemPool || itemPool.length === 0) {
        // プールが空の場合もシードを進める
        const s3 = xorshift32(s2);
        return { drawnItemId: 999, endSeed: s3 }; 
    }

    const s3 = xorshift32(s2);
    let drawnIndex = s3 % itemPool.length;
    let drawnItemId = itemPool[drawnIndex];

    return { drawnItemId: drawnItemId, endSeed: s3 };
}


/**
 * ターゲットシーケンス検索のメインループ
 */
function performSearch_js(startSeed, count, targetSequence, stopOnFound, workerIndex) {
    let currentSeedToTest = startSeed;
    let processedCount = 0;
    const seqLength = targetSequence.length;

    // 検索処理
    for (let i = 0; i < count; i++) {

        let tempSeed = currentSeedToTest;
        let lastItemId = 0; // ガチャシミュレーションの内部変数としてのみ使用
        let matchMask = 0;
        let isMatch = true;
        
        // ターゲットシーケンスの長さ分、ガチャをシミュレーション
        for (let j = 0; j < seqLength; j++) {
            const result = advanceOneStep(tempSeed); // lastItemIdを渡さない（シンプルなシミュレーションのため）
            tempSeed = result.endSeed; 
            
            const targetId = targetSequence[j];
            const drawnId = result.drawnItemId;
            
            // 目玉アイテム (-1) または特定のアイテムIDに一致するか
            if (targetId === drawnId) {
                matchMask |= (1 << j);
            } else {
                isMatch = false;
                break;
            }
        }
        
        if (isMatch) {
            // 結果をメインスレッドに報告
            postMessage({ type: 'result', seed: currentSeedToTest, mask: matchMask, workerIndex });
            
            if (stopOnFound) {
                postMessage({ type: 'done', processed: processedCount, workerIndex });
                return; 
            }
        }

        processedCount++;

        // 進捗報告（50万件ごとにメインスレッドへ報告）
        if (processedCount % 500000 === 0) {
            postMessage({ type: 'progress', processed: 500000, workerIndex });
        }

        currentSeedToTest = (currentSeedToTest + 1) >>> 0;
    }
    
    // 残りの進捗を報告
    const remainingProgress = processedCount % 500000;
    if (remainingProgress > 0) {
         postMessage({ type: 'progress', processed: remainingProgress, workerIndex });
    }
    
    // 完了メッセージ
    postMessage({ type: 'done', processed: processedCount, workerIndex });
}

/**
 * 渡された生データからガチャ計算に必要な累積排出率とプール情報を構築
 */
function setupGachaData(rawGacha, rawItemMaster) {
    
    // 1. 累積排出率の計算
    const cumulativeRates = [];
    let cumulativeSum = 0;
    // レアリティは0から4までの5種類を想定
    for (let i = 0; i <= 4; i++) {
        cumulativeSum += rawGacha.rarityRates[i.toString()] || 0;
        cumulativeRates.push(cumulativeSum); 
    }
    
    // 2. アイテムをレアリティプールに分類
    const rarityItems = { '0': [], '1': [], '2': [], '3': [], '4': [] };
    rawGacha.pool.forEach(itemId => {
        const itemInfo = rawItemMaster[itemId.toString()]; // itemMasterのキーは文字列
        if (itemInfo && itemInfo.rarity !== undefined && itemInfo.rarity >= 0 && itemInfo.rarity <= 4) {
            rarityItems[itemInfo.rarity.toString()].push(itemId);
        }
    });

    return {
        featuredItemRate: rawGacha.featuredItemRate,
        cumulativeRarityRates: cumulativeRates,
        rarityItems: rarityItems
    };
}


// --- Main Message Handler ---
self.onmessage = function(e) {
    try {
        const data = e.data;
        
        if (data.type === 'search') {
            
            const {
                initialStartSeed, count, targetSequence, 
                stopOnFound, workerIndex, gachaData: rawGacha, itemMaster: rawItemMaster
            } = data;
            
            itemMaster = rawItemMaster;
            gachaData = setupGachaData(rawGacha, rawItemMaster);
            
            performSearch_js(
                initialStartSeed, 
                count, 
                targetSequence, 
                stopOnFound, 
                workerIndex
            );
        }
    } catch (error) {
        console.error(`Worker ${e.data.workerIndex || 'Unknown'}で致命的なエラー:`, error);
        postMessage({ 
            type: 'error', 
            workerIndex: e.data.workerIndex || -1,
            message: error.message 
        });
    }
};