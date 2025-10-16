// seeker_worker.js (SAB版)

// --- Global Data (Worker Scope) ---
let gachaData;
let seekerConfig;
let resultView; // Uint32Array view
let progressView; // Uint32Array view
let stopView; // Uint32Array view

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
function advanceOneStep(currentSeed) { 
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
    let rarityId = -1;
    
    // 累積排出率をチェック
    for (let i = 0; i < gacha.cumulativeRarityRates.length; i++) {
        if (rarityVal < gacha.cumulativeRarityRates[i]) {
            rarityId = i;
            break;
        }
    }
    
    // 4. アイテム排出 (S3)
    if (rarityId === -1) {
        const s3 = xorshift32(s2);
        return { drawnItemId: 999, endSeed: s3 }; 
    }
    
    const itemPool = gacha.rarityItems[rarityId.toString()]; 
    if (!itemPool || itemPool.length === 0) {
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
        
        // 停止フラグチェック（高速化のため5万回に1回）
        if (i % 50000 === 0 && stopView[seekerConfig.SAB_STOP_FLAG] === 1) {
            break; 
        }

        let tempSeed = currentSeedToTest;
        let lastItemId = 0; 
        let matchMask = 0;
        let isMatch = true;
        
        // ターゲットシーケンスの長さ分、ガチャをシミュレーション
        for (let j = 0; j < seqLength; j++) {
            const result = advanceOneStep(tempSeed);
            tempSeed = result.endSeed; 
            
            const targetId = targetSequence[j];
            const drawnId = result.drawnItemId;
            
            // ターゲットIDと排出IDが一致するかを判定
            if (targetId === drawnId) {
                matchMask |= (1 << j);
            } else {
                isMatch = false;
                break;
            }
        }
        
        // 全てのターゲットが連続して一致した場合
        if (isMatch) {
            // 結果をSABに書き込む
            const currentResults = Atomics.load(resultView, seekerConfig.SAB_RESULT_COUNT);
            
            if (currentResults < 5000) { // MAX_RESULTS制限
                const writeOffset = 1 + (currentResults * 2);
                
                Atomics.store(resultView, writeOffset, currentSeedToTest); // SEED
                Atomics.store(resultView, writeOffset + 1, matchMask); // マスク
                
                // 結果カウントをアトミックにインクリメント
                Atomics.add(resultView, seekerConfig.SAB_RESULT_COUNT, 1);
                
                if (stopOnFound) {
                    // 停止フラグをセット
                    Atomics.store(stopView, seekerConfig.SAB_STOP_FLAG, 1);
                    break;
                }
            }
        }

        processedCount++;

        // 進捗報告（50万件ごとにSABを更新）
        if (processedCount % 500000 === 0) {
            Atomics.add(progressView, seekerConfig.SAB_PROGRESS_PROCESSED, 500000);
        }

        currentSeedToTest = (currentSeedToTest + 1) >>> 0;
    }
    
    // 残りの進捗を報告
    const remainingProgress = processedCount % 500000;
    if (remainingProgress > 0) {
         Atomics.add(progressView, seekerConfig.SAB_PROGRESS_PROCESSED, remainingProgress);
    }
    
    // 完了メッセージ（メインスレッドにWorkerが終了したことを通知）
    postMessage({ type: 'done', workerIndex });
}

/**
 * SABからマスターデータをアンパックし、WorkerローカルのgachaData構造を構築
 */
function setupGachaDataFromSab(masterDataSab, config) {
    const masterView = new Uint32Array(masterDataSab);
    const gacha = {};

    // 1. Gacha情報 (Featured Item Rate & Cumulative Rarity Rates)
    const gachaStart = config.MASTER_H_GACHA_START_OFFSET;
    gacha.featuredItemRate = masterView[gachaStart + 0];
    gacha.cumulativeRarityRates = [];
    
    // Cumulative rates (R0, R1, R2, R3, R4)
    for(let i = 1; i <= 5; i++) {
        gacha.cumulativeRarityRates.push(masterView[gachaStart + i]);
    }
    
    // 2. レアリティプール情報 (Rarity Items)
    gacha.rarityItems = {};
    const rarityPoolStartPtr = config.MASTER_H_RARITY_POOL_START;

    // 5つのレアリティプールを読み込む
    for (let i = 0; i < 5; i++) {
        const metadataPtr = rarityPoolStartPtr + (i * 3);
        const rarityId = masterView[metadataPtr];
        const length = masterView[metadataPtr + 1];
        const offset = masterView[metadataPtr + 2];
        
        if (length > 0) {
            const itemPool = [];
            for(let k = 0; k < length; k++) {
                itemPool.push(masterView[offset + k]);
            }
            gacha.rarityItems[rarityId.toString()] = itemPool;
        } else {
             gacha.rarityItems[rarityId.toString()] = [];
        }
    }
    
    return gacha;
}


// --- Main Message Handler ---
self.onmessage = function(e) {
    try {
        const data = e.data;
        
        if (data.type === 'search') {
            
            // SABのビューを初期化 (グローバル変数に格納)
            seekerConfig = data.seekerConfig;
            resultView = new Uint32Array(data.resultSab);
            progressView = new Uint32Array(data.progressSab);
            stopView = new Uint32Array(data.stopSab);

            // マスターデータをアンパック
            gachaData = setupGachaDataFromSab(data.masterDataSab, seekerConfig);
            
            // 検索開始
            performSearch_js(
                data.initialStartSeed, 
                data.count, 
                data.targetSequence, 
                data.stopOnFound, 
                data.workerIndex
            );
        }
    } catch (error) {
        // 処理中に予期せぬエラーが発生した場合、メインスレッドに報告してWorkerを終了させる
        console.error(`Worker ${e.data.workerIndex || 'Unknown'}で致命的なエラー:`, error);
        postMessage({ 
            type: 'error', 
            workerIndex: e.data.workerIndex || -1,
            message: error.message 
        });
    }
};
