/**
 * TransColors Telegram Bot Worker
 */

export default {
  async fetch(request, env, ctx) {
    try {
      const response = await handleRequest(request, env);
      return response;
    } catch (error) {
      console.error({
        event: "服务器错误",
        error_message: error.message,
        error_stack: error.stack,
        url: request.url
      });

      return new Response(`服务器错误: ${error.message}`, { status: 500 });
    }
  }
};

// 添加时间戳
Object.defineProperty(globalThis, "START_TIME", { value: Date.now() });

// 配置项
const RATE_LIMIT = {
  REQUESTS_PER_USER: 50,     // 每个用户每天的请求上限
  REQUESTS_PER_MINUTE: 10,    // 每个用户每分钟的请求上限
  TOTAL_DAILY_LIMIT: 2000     // 所有用户每天的总请求上限
};

const MESSAGE_LIMIT = {
  MAX_LENGTH: 1024  // Telegram消息限制
};

const HISTORY_CONFIG = {
  MAX_ROUNDS: 10,             // 最多保存10轮对话
  TTL_DAYS: 7                 // 对话历史保存7天
};

const KV_KEYS = {
  USER_MODEL: "user_model:",         // 用户模型偏好前缀
  USER_DAILY_COUNT: "user_count:",   // 用户每日请求计数前缀
  USER_TIMESTAMPS: "user_ts:",       // 用户请求时间戳前缀
  TOTAL_REQUESTS: "total_requests",  // 总请求数
  LAST_RESET_DAY: "last_reset_day",  // 上次重置日期
  USER_RESET_DATE: "user_reset:",    // 用户上次重置日期前缀
  ADMIN_USERS: "admin_users",        // 管理员用户名列表
  USER_MESSAGES: "user_messages:",   // 用户对话历史
  HISTORY_TTL: 86400 * HISTORY_CONFIG.TTL_DAYS  // 对话历史保存时间
};

// 模型配置
const MODELS = {
  openai: {
    model: "gpt-4o",
    temperature: 0.5,
    max_tokens: 4096,
    endpoint: "https://api.openai.com/v1/chat/completions"
  },
  grok: {
    model: "grok-3-latest", 
    temperature: 0.5,
    max_tokens: 2048,
    endpoint: "https://api.x.ai/v1/chat/completions"
  }
};

const DEFAULT_MODEL = "grok";

/**
 * 检查并更新用户使用量
 * 返回是否允许此次请求
 */
async function checkAndUpdateUsage(userId, username, env) {
  // 检查用户是否为管理员
  const adminUsersStr = await env.TRANS_COLORS_KV.get(KV_KEYS.ADMIN_USERS) || "[]";
  const adminUsers = JSON.parse(adminUsersStr);
  const isAdmin = username && adminUsers.includes(username);
  
  const now = new Date();
  // 使用YYYY-MM-DD格式的日期字符串
  const currentDateStr = now.toISOString().split('T')[0];
  
  // 获取上次重置日期
  let lastResetDay = await env.TRANS_COLORS_KV.get(KV_KEYS.LAST_RESET_DAY) || currentDateStr;
  
  // 获取用户的上次重置日期
  const userResetKey = KV_KEYS.USER_RESET_DATE + userId;
  let userLastResetDay = await env.TRANS_COLORS_KV.get(userResetKey) || "";
  
  // 检查是否需要重置全局计数
  if (currentDateStr !== lastResetDay) {
    await env.TRANS_COLORS_KV.put(KV_KEYS.LAST_RESET_DAY, currentDateStr);
    await env.TRANS_COLORS_KV.put(KV_KEYS.TOTAL_REQUESTS, "0");
    lastResetDay = currentDateStr;
  }
  
  // 检查是否需要重置此用户的计数
  const userCountKey = KV_KEYS.USER_DAILY_COUNT + userId;
  if (currentDateStr !== userLastResetDay) {
    await env.TRANS_COLORS_KV.put(userCountKey, "0");
    await env.TRANS_COLORS_KV.put(userResetKey, currentDateStr);
    userLastResetDay = currentDateStr;
  }
  
  // 获取总体每日请求数
  let totalDailyRequests = parseInt(await env.TRANS_COLORS_KV.get(KV_KEYS.TOTAL_REQUESTS) || "0");
  
  if (totalDailyRequests >= RATE_LIMIT.TOTAL_DAILY_LIMIT && !isAdmin) {
    return {
      allowed: false,
      reason: "机器人已达到今日总请求上限，请明天再试。"
    };
  }
  
  // 获取用户每日请求计数
  let userRequestCount = parseInt(await env.TRANS_COLORS_KV.get(userCountKey) || "0");
  
  // 检查用户每日限制
  if (userRequestCount >= RATE_LIMIT.REQUESTS_PER_USER && !isAdmin) {
    return {
      allowed: false,
      reason: `您今日的请求次数（${RATE_LIMIT.REQUESTS_PER_USER}次）已用完，请明天再试。`
    };
  }
  
  // 获取用户请求时间戳
  const userTimestampsKey = KV_KEYS.USER_TIMESTAMPS + userId;
  let userTimestamps = JSON.parse(await env.TRANS_COLORS_KV.get(userTimestampsKey) || "[]");
  
  // 清理一分钟前的时间戳
  const oneMinuteAgo = now.getTime() - 60000;
  userTimestamps = userTimestamps.filter(timestamp => timestamp > oneMinuteAgo);
  
  // 检查每分钟频率限制 - 管理员不受此限制
  if (userTimestamps.length >= RATE_LIMIT.REQUESTS_PER_MINUTE && !isAdmin) {
    return {
      allowed: false,
      reason: `请求过于频繁，请稍后再试。每分钟最多 ${RATE_LIMIT.REQUESTS_PER_MINUTE} 次请求。`
    };
  }
  
  userRequestCount++;
  userTimestamps.push(now.getTime());
  totalDailyRequests++;
  
  await env.TRANS_COLORS_KV.put(userCountKey, userRequestCount.toString());
  await env.TRANS_COLORS_KV.put(userTimestampsKey, JSON.stringify(userTimestamps));
  await env.TRANS_COLORS_KV.put(KV_KEYS.TOTAL_REQUESTS, totalDailyRequests.toString());
  
  return {
    allowed: true,
    isAdmin: isAdmin
  };
}

class UpdateController {
  constructor() {
    this.buffer = [];
    this.lastUpdate = Date.now();
    this.updateInterval = 1500;
  }

  shouldUpdate(newContent) {
    const timeDiff = Date.now() - this.lastUpdate;
    return timeDiff >= this.updateInterval;
  }

  async triggerUpdate(content, callback) {
    this.lastContent = content;
    this.lastUpdate = Date.now();
    await callback(content);
  }

  reset() {
    this.buffer = [];
    this.lastUpdate = Date.now();
  }
}

async function handleRequest(request, env) {
  const BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
  const API_KEY = env.OPENAI_API_KEY;

  if (request.method !== 'POST') {
    return new Response('请使用 POST 请求', { status: 405 });
  }

  try {
    const update = await request.json();

    if (!update.message) {
      return new Response('OK');
    }

    const chatId = update.message.chat.id;
    const chatType = update.message.chat.type;
    const userId = update.message.from.id;
    const text = update.message.text || '';
    const username = update.message.from.username || 'user';

    // 获取机器人信息(仅在非私聊时获取)
    let botUsername = null;
    if (chatType !== 'private') {
      const botInfo = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`).then(r => r.json());
      botUsername = botInfo.result.username;
    }

    console.log({
      event: "机器人接受消息",
      chat_id: chatId,
      chat_type: chatType,
      user_id: userId,
      username: username,
      message_text: text.substring(0, 100)
    });

    // 检查是否为非文本消息（图片、视频、文件等）
    if (!text && (update.message.photo || update.message.video || 
        update.message.document || update.message.audio || 
        update.message.voice || update.message.sticker || 
        update.message.animation)) {
      
      // 在群聊中，只有@机器人或回复机器人的非文本消息才回复
      if (chatType !== 'private') {
        const isReply = update.message.reply_to_message && 
                        update.message.reply_to_message.from && 
                        update.message.reply_to_message.from.username === botUsername;
                        
        if (!isReply) {
          return new Response('OK');
        }
      }
      
      return sendMessage(chatId, "抱歉，我目前只能处理文字消息。请发送文字内容与我交流。", env);
    }

    // 群聊中检查是否需要回复
    if (chatType !== 'private') {
      const shouldRespond = shouldRespondInGroup(text, update, botUsername);
      if (!shouldRespond) {
        return new Response('OK');
      }
    }

    // 清理文本中的@部分
    let cleanText = text;
    if (chatType !== 'private' && text.includes('@' + botUsername)) {
      cleanText = text.replace('@' + botUsername, '').trim();
    }

    if (cleanText.startsWith('/')) {
      return handleCommand(chatId, cleanText, username, userId, env);
    }

    const usageCheck = await checkAndUpdateUsage(userId, username, env);
    if (!usageCheck.allowed) {
      return sendMessage(chatId, usageCheck.reason, env);
    }

    return handleMessage(chatId, cleanText || text, username, userId, env, chatType);
  } catch (error) {
    console.error('处理请求时出错:', error);
    return new Response('发生错误: ' + error.message, { status: 500 });
  }
}

/**
 * 检查群聊中是否需要响应
 */
function shouldRespondInGroup(text, update, botUsername) {
  // 检查是否@了机器人
  const isTagged = text.includes('@' + botUsername);
  
  // 检查是否回复了机器人消息
  const isReply = update.message.reply_to_message && 
                  update.message.reply_to_message.from && 
                  update.message.reply_to_message.from.username === botUsername;
  
  // 检查命令是否明确@了当前机器人
  if (text.startsWith('/')) {
    const fullCommand = text.split(' ')[0];
    if (fullCommand.includes('@')) {
      return fullCommand.split('@')[1] === botUsername;
    }
    return false; // 群聊中不带@的命令不处理
  }
  
  return isTagged || isReply;
}

async function handleCommand(chatId, command, username, userId, env) {
  // 提取真正的命令部分，移除可能存在的@botname
  let cmd = command.split(' ')[0].toLowerCase();
  if (cmd.includes('@')) {
    cmd = cmd.split('@')[0].toLowerCase();
  }
  
  const args = command.split(' ').slice(1);

  switch (cmd) {
    case '/start':
      return sendMessage(chatId, '👋 欢迎使用TransColors LLM！\n\n我是为追求自我定义与突破既定命运的人设计的助手。提供医疗知识、心理支持、身份探索、生活适应、移民信息、职业发展和法律权益等多方面支持。所有信息仅供参考，重要决策请咨询专业人士。\n\n输入 /help 可查看完整使用指南。', env);

    case '/help':
      const adminUsersStr = await env.TRANS_COLORS_KV.get(KV_KEYS.ADMIN_USERS) || "[]";
      const adminUsers = JSON.parse(adminUsersStr);
      const isAdmin = username && adminUsers.includes(username);

      let helpText = '🌈 TransColors LLM 使用指南\n\n可用命令:\n/start - 开始对话\n/help - 显示此帮助信息\n/quota - 查看您的使用额度\n/model - 选择使用的模型\n/clear - 清除当前对话历史\n\n您可以直接向我提问，我会尽力提供准确、有用的信息。我的设计初衷是为更广泛的身份认同与生活方式提供支持与资源。\n\n使用限制:\n- 每人每日最多30次请求\n- 每分钟最多10次请求\n- 系统可记住最近' + HISTORY_CONFIG.MAX_ROUNDS + '轮对话\n- 对话历史将在' + HISTORY_CONFIG.TTL_DAYS + '天后自动过期\n\n备注：所有信息仅供参考，重要决策请咨询专业人士。';

      if (isAdmin) {
        helpText += '\n\n🔑 您是管理员，不受请求配额限制。\n管理员命令：\n/admin_add [用户名] - 添加新管理员';
      }

      try {
        const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            chat_id: chatId,
            text: helpText
          })
        });

        return new Response('OK');
      } catch (error) {
        return new Response('发送帮助消息失败', { status: 500 });
      }

    case '/quota':
      const userCountKey = KV_KEYS.USER_DAILY_COUNT + userId;
      
      const now = new Date();
      const currentDateStr = now.toISOString().split('T')[0];
      
      let lastResetDay = await env.TRANS_COLORS_KV.get(KV_KEYS.LAST_RESET_DAY) || currentDateStr;
      
      const userResetKey = KV_KEYS.USER_RESET_DATE + userId;
      let userLastResetDay = await env.TRANS_COLORS_KV.get(userResetKey) || "";
      
      if (currentDateStr !== lastResetDay) {
        await env.TRANS_COLORS_KV.put(KV_KEYS.LAST_RESET_DAY, currentDateStr);
        await env.TRANS_COLORS_KV.put(KV_KEYS.TOTAL_REQUESTS, "0");
        lastResetDay = currentDateStr;
      }
      
      if (currentDateStr !== userLastResetDay) {
        await env.TRANS_COLORS_KV.put(userCountKey, "0");
        await env.TRANS_COLORS_KV.put(userResetKey, currentDateStr);
        userLastResetDay = currentDateStr;
      }
      
      const dailyCount = parseInt(await env.TRANS_COLORS_KV.get(userCountKey) || "0");
      const remainingCount = RATE_LIMIT.REQUESTS_PER_USER - dailyCount;
      
      const totalRequests = parseInt(await env.TRANS_COLORS_KV.get(KV_KEYS.TOTAL_REQUESTS) || "0");
      
      const quotaAdminUsersStr = await env.TRANS_COLORS_KV.get(KV_KEYS.ADMIN_USERS) || "[]";
      const quotaAdminUsers = JSON.parse(quotaAdminUsersStr);
      const isQuotaAdmin = username && quotaAdminUsers.includes(username);
      
      let quotaText = `📊 使用额度统计\n\n今日已使用: ${dailyCount}次\n剩余额度: ${isQuotaAdmin ? "无限制" : remainingCount + "次"}\n\n每分钟最多可发送${RATE_LIMIT.REQUESTS_PER_MINUTE}次请求。\n\n机器人今日总请求数: ${totalRequests}次\n机器人每日总上限: ${RATE_LIMIT.TOTAL_DAILY_LIMIT}次`;
      
      if (isQuotaAdmin) {
        quotaText += '\n\n🔑 您是管理员，不受配额限制。';
      }

      try {
        const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            chat_id: chatId,
            text: quotaText
          })
        });

        return new Response('OK');
      } catch (error) {
        return new Response('发送配额消息失败', { status: 500 });
      }

    case '/model':
      const modelArg = command.split(' ')[1]?.toLowerCase();

      if (modelArg && MODELS[modelArg]) {
        await env.TRANS_COLORS_KV.put(KV_KEYS.USER_MODEL + userId, modelArg);
        return sendMessage(chatId, `✅ 您的默认模型已设置为: ${modelArg}\n\n当前模型参数:\n- temperature(越低越理性, 越高越感性): ${MODELS[modelArg].temperature}\n- 最大令牌数: ${MODELS[modelArg].max_tokens}`, env);
      }

      const userModel = await env.TRANS_COLORS_KV.get(KV_KEYS.USER_MODEL + userId);
      const modelsList = Object.keys(MODELS).map(key => {
        const isDefault = (key === DEFAULT_MODEL) ? ' (默认)' : '';
        const isUserPref = (key === userModel) ? ' (✓ 您的选择)' : '';
        return `- ${key}${isDefault}${isUserPref}`;
      }).join('\n');

      return sendMessage(chatId, `🤖 *可用模型*\n\n${modelsList}\n\n要选择模型，请使用命令: /model [模型名称]\n例如: /model grok`, env);

    case '/clear':
      const clearHistoryKey = `${KV_KEYS.USER_MESSAGES}${chatId}_${userId}`;
      await env.TRANS_COLORS_KV.delete(clearHistoryKey);
      return sendMessage(chatId, "✅ 您在当前聊天的对话历史已清除", env);

    case '/admin_add':
      const adminAddStr = await env.TRANS_COLORS_KV.get(KV_KEYS.ADMIN_USERS) || "[]";
      const adminList = JSON.parse(adminAddStr);
      const isAddAdmin = username && adminList.includes(username);

      if (!isAddAdmin) {
        return sendMessage(chatId, "⛔ 您没有权限执行此命令。只有管理员可以添加其他管理员。", env);
      }

      if (!args[0]) {
        return sendMessage(chatId, "❗ 请指定要添加的管理员用户名。\n用法: /admin_add [用户名]", env);
      }

      const newAdmin = args[0].replace('@', '');

      if (adminList.includes(newAdmin)) {
        return sendMessage(chatId, `⚠️ @${newAdmin} 已经是管理员。`, env);
      }

      adminList.push(newAdmin);
      await env.TRANS_COLORS_KV.put(KV_KEYS.ADMIN_USERS, JSON.stringify(adminList));

      return sendMessage(chatId, `✅ 已将 @${newAdmin} 添加为管理员。`, env);

    default:
      return new Response('OK');
  }
}

async function handleMessage(chatId, text, username, userId, env, chatType) {
  let placeholderMessageId = null;
  let currentMessageId = null;
  let currentContent = '';
  let lastContent = '';
  
  try {
    const placeholder = await sendMessageGetMessageid(chatId, "⏳ 正在思考中...", env);
    placeholderMessageId = placeholder.message_id;
    currentMessageId = placeholderMessageId;
    
    await sendChatAction(chatId, 'typing', env);

    const userModel = await env.TRANS_COLORS_KV.get(KV_KEYS.USER_MODEL + userId);
    const modelProvider = userModel || DEFAULT_MODEL;

    const historyKey = `${KV_KEYS.USER_MESSAGES}${chatId}_${userId}`;
    let messages = JSON.parse(await env.TRANS_COLORS_KV.get(historyKey) || "[]");
    
    messages.push({role: "user", content: text});
    
    const maxMessages = HISTORY_CONFIG.MAX_ROUNDS * 2;
    if (messages.length > maxMessages) {
      messages = messages.slice(-maxMessages);
    }

    console.log({
      event: "机器人请求大模型API",
      chat_id: chatId,
      chat_type: chatType || 'unknown',
      user_id: userId,
      username: username,
      text_length: text.length,
      model: modelProvider,
      message_text: text.substring(0, 100),
      timestamp: new Date().toISOString()
    });
    
    const updateCtrl = new UpdateController();
    let finalAnswer = '';
      
    finalAnswer = await callLLM(
      modelProvider,
      text,
      messages,
      env,
      async (partial) => {
        // 只处理新增的内容
        const newContent = partial.slice(lastContent.length);
        lastContent = partial;
        finalAnswer = partial;

        if (updateCtrl.shouldUpdate(partial)) {
          // 检查当前消息加上新内容是否会超出限制
          if (currentContent.length + newContent.length >= MESSAGE_LIMIT.MAX_LENGTH - 100) { // 留出100字符的缓冲区
            // 发送新消息
            const newMessage = await sendMessageGetMessageid(chatId, newContent, env);
            currentMessageId = newMessage.message_id;
            currentContent = newContent;
          } else {
            // 更新当前消息
            currentContent += newContent;
            await editMessageText(chatId, currentMessageId, currentContent, env);
          }
          await updateCtrl.triggerUpdate(partial, async () => {});
        }
      }
    );

    // 处理最后剩余的内容
    const remainingContent = finalAnswer.slice(lastContent.length);
    if (remainingContent) {
      if (currentContent.length + remainingContent.length >= MESSAGE_LIMIT.MAX_LENGTH - 100) {
        await sendMessage(chatId, remainingContent, env);
      } else {
        await editMessageText(chatId, currentMessageId, currentContent + remainingContent, env);
      }
    }

    console.log({
      event: "机器人回答结束",
      chat_id: chatId,
      chat_type: chatType || 'unknown',
      user_id: userId,
      username: username,
      model: modelProvider,
      message_text: finalAnswer.substring(0, 100),
      timestamp: new Date().toISOString()
    });
    
    messages.push({role: "assistant", content: finalAnswer});
    
    await env.TRANS_COLORS_KV.put(historyKey, JSON.stringify(messages), {
      expirationTtl: KV_KEYS.HISTORY_TTL
    });
    return new Response('OK');

  } catch (error) {
    console.error({
      event: "机器人请求大模型API报错",
      chat_id: chatId,
      user_id: userId,
      username: username,
      message_text: text.substring(0, 100),
      error_message: error.message,
      error_type: error.name,
      error_stack: error.stack,
      timestamp: new Date().toISOString()
    });

    try {
      await sendMessage(chatId, '⚠️ 抱歉，处理您的请求时发生错误，请联系开发者。', env);
    } catch (sendError) {
      console.error('发送错误消息时出错:', sendError);
    }

    return new Response('OK');
  }
}

async function callLLM(provider, text, messages, env, onData) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);
  const modelConfig = MODELS[provider];
  
  const systemPrompt = `你是TransColors助手, 为所有追求自我定义、挑战既定命运的人提供支持和信息。你涵盖以下领域：

1. 医学知识：药物作用机制、副作用、替代治疗选择
2. 心理健康：应对变化、自我接纳、寻找支持系统
3. 身体自主：各类医疗和非医疗身体改变选项及其影响
4. 社会适应：在各种社会环境中的自我表达和融入策略
5. 地理流动：不同国家和地区的政策、移民路径、文化差异
6. 职业发展：职业转换、远程工作、非传统生活方式支持
7. 法律权益：各地相关法律知识、权益保障、应对歧视

回答时保持开放、尊重和专业，不预设任何人的身份或选择。承认每个人的经历和需求都是独特的，避免给出一刀切的建议。提供信息时注明这些仅供参考，关键决策应结合个人情况和专业咨询。支持每个人打破常规、寻找自己道路的勇气。考虑用户一般在移动端使用, 回复要简短, 除非用户要求详细解释。
假如用户让你扮演某个角色陪聊天的话, 那么就不再扮演TransColors助手, 而是扮演那个角色, 并且回答时使用那个角色的口吻。
但是无论如何都禁止讨论煽动暴力或恐怖主义、儿童色情、毒品贩卖，但在用户无犯罪意图的情况下可以提供这些话题的 wikipedia 级别的科普信息。`;

  let apiKey;
  if (provider === 'grok') {
    apiKey = env.XAI_API_KEY;
  } else if(provider === 'openai') {
    apiKey = env.OPENAI_API_KEY;
  }

  try {
    const response = await fetch(modelConfig.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: modelConfig.model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages
        ],
        temperature: modelConfig.temperature,
        max_tokens: modelConfig.max_tokens,
        stream: true
      }),
      signal: controller.signal
  });

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let answer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break;

        try {
          const json = JSON.parse(data);
          const chunk = json.choices[0]?.delta?.content || '';
          if (chunk) {
            answer += chunk;
            await onData(answer);
          }
        } catch (e) {
          console.warn("JSON parse error:", e);
        }
      }
    }

    return answer;

 } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error("API响应超时");
    }
    console.error({
      event: "大模型API响应报错",
      provider: provider,
      error_message: error.message,
      error_type: error.name,
      error_stack: error.stack,
      model: modelConfig.model,
      message_text: text.substring(0, 100),
      endpoint: modelConfig.endpoint,
      timestamp: new Date().toISOString()
    });
    throw error;
  } finally {
    clearTimeout(timeoutId);
}
}

async function editMessageText(chatId, messageId, text, env) {
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: text,
        parse_mode: 'Markdown'
      })
    });
  } catch (error) {
    console.error("Edit message failed:", error);
  }
}

async function sendMessage(chatId, text, env) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown'
      })
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('发送Telegram消息失败:', error);
    }

    return new Response('OK');
  } catch (error) {
    console.error('发送Telegram消息时出错:', error.message);
    return new Response('发送消息失败: ' + error.message, { status: 500 });
  }
}

async function sendMessageGetMessageid(chatId, text, env) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown'
      })
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('发送Telegram消息失败:', error);
      throw new Error('发送消息失败');
    }

    const data = await response.json();
    return data.result;

  } catch (error) {
    console.error('发送Telegram消息时出错:', error.message);
    throw error;
  }
}

async function sendChatAction(chatId, action, env) {
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: chatId,
        action: action
      })
    });
  } catch (error) {
    console.error('发送ChatAction时出错:', error.message);
  }
}  
