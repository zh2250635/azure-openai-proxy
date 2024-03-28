import time
import requests
import json

apiBase = "http://24.144.69.221:3000/v1/chat/completions"
apiKey = "sk-XXJlp2Y7z6OfIm8MD674Ea1a415e4877A080Db2d8eF410A2"

payload = {
    "messages":[
        {
            "role":"user",
            "content":"写一篇1000字的，关于友谊的论文"
        }
    ],
    "model":"gpt-4-32k-1106-preview",
    "stream":True
}

headers = {
    "Authorization": f"Bearer {apiKey}"
}

response = requests.post(url=apiBase, headers=headers, json=payload, stream=True)

if response.status_code != 200:
    print(f"Error: {response.status_code}")
    exit()

# 遍历响应内容
for line in response.iter_lines():
    if line:
        try:
            line = line.decode('utf-8')
            if line == 'data: [DONE]':
                break
            # 去除每一行的data: 前缀
            txtLine = line[6:]
            jsonData = json.loads(txtLine)
            content = jsonData['choices'][0]['delta']['content'] if len(jsonData['choices']) > 0 else ''
            if content:
                print(content, end='')
                # time.sleep(0.5)
        except Exception as e:
            print(f"Error: {e}")
            print(f"Error: {txtLine}")
            continue

print("\nDone")