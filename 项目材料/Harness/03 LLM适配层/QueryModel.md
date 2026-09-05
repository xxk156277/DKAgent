### QueryModel 包括以下模块：

1. Providers 接口：抹平不同模型 API 的差异
2. StreamParser：把流式结果组装成结构化 JSON
3. Retry
    1. 定义错误分裂
    2. 指数退避 一个函数
4. 令牌分桶算法
5. Cache：避免重复调用
6. Router：按照规则，给每个任务分配不同的模型
7. Token Counter：预算管理

### QueryModel 定义

```ts
export class QueryEngine {
	// 模型 map
	private providers: Map<string, LLMProvider>;
	// 缓存
	private cache: QueryCache; 
	// 异步操作控制并发速率
	private rateLimiter: TokenBucketLimiter; 
	// 模型分配器
	private router: ModelRouter; 
	// token计算器
	private tokenCounter: TokenCounter;

	constructor(){
		// 初始化
	}
	
	query(){
		// 1. tokenCounter:计算token 如果token超过就报 rate_limit
		
		// 2. router:模型分配
		
		// 3. cache:缓存检查
				// 基于 model + messages + tools 生成确定性 hash
				// 如果hash一直就用缓存
		// 4. rateLimiter:限流等待
		// 5. providers:带重试的模型调用
		// 6. tokenCounter:记录消耗
		// 7. cache:写入缓存
	
	}

	getUsageSummary(){
		// 获取token总消耗
	}

}


```
