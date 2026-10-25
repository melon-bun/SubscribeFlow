# Codex：直接ctypes提取OpenSSL构建链

用户要求已执行；只处理冻结的公开证书，未读取密钥、未发起网络或付费请求，未改产品代码。

脚本dump-chain.py为每个FFI函数完整声明argtypes/restype，使用BIO_new_mem_buf + PEM_read_bio_X509解析PEM，X509_verify_cert之后通过X509_STORE_CTX_get1_chain打印构建链并正确释放引用。旧probe-openssl-verify.py中d2i_X509少传长度参数、把PEM当DER且若干指针函数无完整ABI声明，不能使用其结果下结论。

固定叶子DER SHA256：A6BFC1FD97D8C0F21B37C5EBCB4B4D165CD649AC047E23440876EDAF5A373B5E。leaf.pem与sent-0.pem一致。Node v26.7.0/OpenSSL3.5.7验叶子←YE1=true，←X1=false，←X2=false。YE1的issuer是Root YE，而非X1/X2；YE1 DER SHA256 A2372D06431E9716365EEED47EC020351497D182FCC038E457E58168A03CAC07。

分别直接加载Python绑定libcrypto3.0.13、CLI所用libcrypto4.0.3，同一叶子/同一X1或X2/同一YE1，两者结果一致：仅X1无中间证书失败error20、链只有叶子；X1+untrusted YE1仍失败error20，构建链为wxrank.com→YE1，停在找不到Root YE签发者；X2同样失败。Node完整根库+YE1也失败error20。没有一次固定输入验证得到“X1验通”。这只能说明之前成功结论未在相同受控输入下复现，不能据此认定X1签发了该叶子或盲目加入新信任根。

原始结构化结果：node-comparison.json、openssl-python3.json、openssl-cli4.json。OpenSSL CLI同冻结输入也报error20。下一步若要解释先前urllib成功，须在那一次实际成功连接中同时记录peer DER指纹、实际代理/端点和verified chain，再与本输入比较；不要再做大范围TLS矩阵或扩大生产TLS重构。用户原任务仍是完成真实产品验收，当前不可据此假报已通过。
