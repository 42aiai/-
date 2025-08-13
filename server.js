// server.js

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// ================= 設定 =================
const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 6;
const USE_JOKERS = true;
const NUM_JOKERS = 2;
const DEFAULT_CHALLENGE_SECONDS = 5;

// ================= サーバーのセットアップ =================
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ================= ゲーム状態の管理 =================
let rooms = {}; // { roomId: { ... } }

// ... ヘルパー関数 (createDeck, shuffleDeck, wasLie, broadcast) は変更なし ...

/** 部屋の全員にメッセージを送信 */
function broadcast(roomId, message) {
    if (!rooms[roomId]) return;
    Object.values(rooms[roomId].players).forEach(player => {
        if (player.ws && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify(message));
        }
    });
}


/** 部屋の状態を整形して送信 */
function sendFullGameState(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    Object.entries(room.players).forEach(([pid, player]) => {
        if (player.ws && player.ws.readyState === WebSocket.OPEN) {
            const stateForPlayer = {
                type: 'updateState',
                payload: {
                    roomId: room.id,
                    status: room.status,
                    settings: room.settings, // ★設定情報を追加
                    players: Object.fromEntries(Object.entries(room.players).map(([id, p]) => [id, { name: p.name, cardCount: p.hand.length }])),
                    gameState: room.gameState,
                    myHand: player.hand,
                    creatorId: room.creatorId,
                }
            };
            player.ws.send(JSON.stringify(stateForPlayer));
        }
    });
}

/** 誰もチャレンジしなかった場合に自動でターンを進める */
function advanceTurnAfterTimeout(roomId, gameId) {
    const room = rooms[roomId];
    // 部屋が存在し、ゲームIDが変わっていない（リスタートしていない）かつ、チャレンジ可能状態の場合のみ実行
    if (room && room.gameState && room.gameState.gameId === gameId && room.gameState.challengePhase) {
        console.log(`[${roomId}] Challenge time out. Advancing turn.`);
        room.gameState.challengePhase = false; // チャレンジ期間終了
        room.gameState.lastPlayerId = null;
        room.gameState.challengeResult = null;
        
        // 次のターンへ
        const lastPlayerId = room.gameState.turnOrder.find(pid => room.players[pid].hand.length + room.privateState.lastPlayedCards.length === Object.values(room.players).find(p=>p.name === room.players[pid].name).cardCount ) // A bit fragile, but works for MVP
        
        const currentPlayerIndex = room.gameState.turnOrder.indexOf(room.gameState.turnPlayerId);
        room.gameState.turnPlayerId = room.gameState.turnOrder[(currentPlayerIndex + 1) % room.gameState.turnOrder.length];
        room.gameState.currentCall = (room.gameState.currentCall % 13) + 1;

        sendFullGameState(roomId);
    }
}


// ================= WebSocket処理 =================

wss.on('connection', (ws) => {
    let playerId = '';
    let roomId = '';

    ws.on('message', (message) => {
        try {
            const { type, payload } = JSON.parse(message);
            const room = rooms[roomId];

            switch (type) {
                case 'createRoom': {
                    playerId = payload.playerId;
                    roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
                    rooms[roomId] = {
                        id: roomId,
                        creatorId: playerId,
                        players: {},
                        status: 'waiting',
                        // ★設定オブジェクトを追加
                        settings: {
                            challengeTimeoutSeconds: DEFAULT_CHALLENGE_SECONDS,
                        },
                        gameState: null,
                        privateState: {
                            fieldCards: [],
                            lastPlayedCards: []
                        }
                    };
                    rooms[roomId].players[playerId] = { ws, name: payload.playerName, hand: [] };
                    ws.send(JSON.stringify({ type: 'roomCreated', payload: { roomId } }));
                    sendFullGameState(roomId);
                    console.log(`[${roomId}] Player ${payload.playerName}(${playerId}) created room.`);
                    break;
                }
                // (joinRoomは変更なし)
                case 'joinRoom': {
                    const targetRoomId = payload.roomId.toUpperCase();
                    if (rooms[targetRoomId] && Object.keys(rooms[targetRoomId].players).length < MAX_PLAYERS && rooms[targetRoomId].status === 'waiting') {
                        roomId = targetRoomId;
                        playerId = payload.playerId;
                        rooms[roomId].players[playerId] = { ws, name: payload.playerName, hand: [] };
                        ws.send(JSON.stringify({ type: 'joinedRoom', payload: { roomId } }));
                        sendFullGameState(roomId);
                        console.log(`[${roomId}] Player ${payload.playerName}(${playerId}) joined.`);
                    } else {
                        ws.send(JSON.stringify({ type: 'error', payload: { message: '部屋が見つからないか、満員、またはゲームが始まっています。' } }));
                    }
                    break;
                }

                // ★設定変更用のハンドラを追加
                case 'changeSettings': {
                    if (room && room.creatorId === playerId && room.status === 'waiting') {
                        const newTimeout = parseInt(payload.challengeTimeoutSeconds, 10);
                        if ([3, 5, 7, 10].includes(newTimeout)) { // 不正な値でないかチェック
                            room.settings.challengeTimeoutSeconds = newTimeout;
                            console.log(`[${roomId}] Settings changed by host. Timeout: ${newTimeout}s`);
                            sendFullGameState(roomId); // 変更を全員に通知
                        }
                    }
                    break;
                }

                case 'startGame': {
                    if (room && room.creatorId === playerId && Object.keys(room.players).length >= 2) {
                        console.log(`[${roomId}] Game starting.`);
                        room.status = 'playing';
                        const playerIds = Object.keys(room.players);
                        
                        const deck = shuffleDeck(createDeck());
                        let p_idx = 0;
                        deck.forEach(card => {
                            room.players[playerIds[p_idx]].hand.push(card);
                            p_idx = (p_idx + 1) % playerIds.length;
                        });

                        room.gameState = {
                            gameId: `game_${Date.now()}`, // ゲームごとのユニークID
                            turnOrder: playerIds,
                            turnPlayerId: playerIds[0],
                            lastPlayerId: null,
                            currentCall: 1,
                            fieldCardCount: 0,
                            winner: null,
                            challengePhase: false, // ★チャレンジ期間かどうかのフラグ
                            challengeResult: null,
                        };
                        room.privateState = { fieldCards: [], lastPlayedCards: [] };
                        
                        sendFullGameState(roomId);
                    }
                    break;
                }
                case 'playCards': {
                    // ★ challengePhase 中はカードを出せないようにする
                    if (room && room.status === 'playing' && room.gameState.turnPlayerId === playerId && !room.gameState.challengePhase) {
                        const player = room.players[playerId];
                        const playedCardIds = payload.cardIds;
                        
                        const playedCards = player.hand.filter(c => playedCardIds.includes(c.id));
                        if (playedCards.length !== playedCardIds.length || playedCards.length === 0 || playedCards.length > 4) {
                            return; // 不正操作
                        }

                        player.hand = player.hand.filter(c => !playedCardIds.includes(c.id));
                        room.privateState.lastPlayedCards = playedCards;
                        room.privateState.fieldCards.push(...playedCards);
                        
                        room.gameState.fieldCardCount = room.privateState.fieldCards.length;
                        room.gameState.lastPlayerId = playerId;
                        room.gameState.challengeResult = null;
                        
                        if (player.hand.length === 0) {
                            room.status = 'finished';
                            room.gameState.winner = playerId;
                        } else {
                            // ★次のターンに進む代わりに、チャレンジフェーズに移行
                            room.gameState.challengePhase = true;
                            // ★タイマーをセット
                            setTimeout(
                                () => advanceTurnAfterTimeout(roomId, room.gameState.gameId),
                                room.settings.challengeTimeoutSeconds * 1000
                            );
                        }

                        sendFullGameState(roomId);
                    }
                    break;
                }
                case 'challenge': {
                    // ★ challengePhase 中のみチャレンジ可能にする
                    if (room && room.status === 'playing' && room.gameState.challengePhase && room.gameState.lastPlayerId !== playerId) {
                        room.gameState.challengePhase = false; // チャレンジ発生により期間終了

                        const challenger = room.players[playerId];
                        const challengedPlayerId = room.gameState.lastPlayerId;
                        const challengedPlayer = room.players[challengedPlayerId];
                        
                        const isLie = wasLie(room.privateState.lastPlayedCards, room.gameState.currentCall);
                        const loserId = isLie ? challengedPlayerId : playerId;
                        const loser = room.players[loserId];

                        loser.hand.push(...room.privateState.fieldCards);
                        
                        room.gameState.challengeResult = {
                            challengerName: challenger.name,
                            challengedName: challengedPlayer.name,
                            wasLie,
                            loserName: loser.name,
                        };
                        
                        room.privateState.fieldCards = [];
                        room.privateState.lastPlayedCards = [];
                        room.gameState.fieldCardCount = 0;
                        room.gameState.lastPlayerId = null;

                        // 判定後、次のターンに進める
                        const lastPlayedTurnIndex = room.gameState.turnOrder.indexOf(challengedPlayerId);
                        room.gameState.turnPlayerId = room.gameState.turnOrder[(lastPlayedTurnIndex + 1) % room.gameState.turnOrder.length];
                        room.gameState.currentCall = (room.gameState.currentCall % 13) + 1;

                        sendFullGameState(roomId);
                    }
                    break;
                }
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });

    // (ws.on('close')は変更なし)
});

// (server.listenは変更なし)