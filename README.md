# WebVPN

### Brief
WebVPN, fully proxy all websites and support session sharing

### Major Update!!!
Session sharing is now supported!!! Multiple people can open the same website and use the same session based on a shared ID. One person can open a membership and multiple people can use it together!!!

### Install
npm install

### Run
node main.js

visit [http://www.your_domain.com/](https://www.your_domain.com/)

### Description
WebVPN can "completely and thoroughly" forward and proxy any third-party website. It is not only a VPN on the Web, but also an advanced intranet penetration tool. It can also be used to make a perfect phishing website (because it perfectly forwards the target website and can also add your own code. But I strongly advise you not to do this. Illegal things are not good. I just want to tell you how awesome this WebVPN is).

Believe me, WebVPN is worthy of its name. When you really use it, you will find that it can do a lot of things you have never thought of. Although it is not perfect yet, it has the basic functions it should have.

If you are interested in this project, please join me to make it better and let more people know about its existence.

If it helps you, you can buy me a cup of milk tea. Thank you very much. I spent thousands of hours and a lot of energy on this. I open source it to facilitate everyone who needs it.

The WebVPN service runs on a primary domain name, and it will encode the domain name of each target URL as the secondary domain name of the WebVPN website. The suffix of the target URL is directly placed in the suffix of the WebVPN URL.
DNS pan-resolution is required, so please be sure to use an SSL wildcard certificate. For local deployment, you can modify the local DNS yourself, and you can use tools such as dnsmasq.

### Contact
Email: 2368354416@qq.com

### 重磅更新！！！
现已支持会话共享！！！多个人可以根据共享id打开同一个网站，使用同一个会话。一个人开会员，多个人可以一同使用！！！

### 简单介绍
WebVPN可以“完全彻底”地转发和代理任何第三方网站，它不仅是Web上的VPN，还是高级内网穿透工具。还可以用来制作完美的钓鱼网站（因为它完美地转发了目标网站，同时还可以加入自己的代码。但我强烈建议你不要这么做，违法的事情不好。我只是想告诉你，这个WebVPN有多牛逼）。

相信我，WebVPN名副其实，当你真正使用它时，你会发现它能做很多你从未想过的事情。虽然它还不够完美，但它应该具备的基本功能已经具备了。

如果你对这个项目感兴趣，欢迎加入我，让它变得更好，让更多的人知道它的存在。

如果对你有帮助，可以请我喝一杯奶茶，非常感谢。我为此花了上千个小时，耗费了巨大的精力，把它开源就是为了方便所有需要它的人。

WebVPN 服务运行到一个主域名上，它会把每个目标网址的域名编码后作为 WebVPN 网站的二级域名。目标网址的后缀，则直接放到 WebVPN 网址的后缀。
DNS泛解析是需要的，所以请务必使用SSL通配符证书。对于本机部署来说，自己修改本地DNS就行，可以使用dnsmasq等工具。

### 单域名代理
如果你不擅长 dnsmasq 等工具，并且只想要代理某几个域名，可以实现！！！
在 config.js 配置文件里，修改 subdomains 即可，比如：
{
  subdomains: {
    'baidu': 'www.baidu.com', // webvpn 服务，二级域名 baidu 指向 www.baidu.com
    'im': 'im.qq.com', // 二级域名 im 指向 im.qq.com
    'weixin': 'weixin.qq.com' // 二级域名 weixin 指向 weixin.qq.com
  }
}

### Thank you
<p>
  <img width="200" src="https://raw.githubusercontent.com/Stardust1001/WebVPN/refs/heads/master/alipay.jpg">
  <img width="200" src="https://raw.githubusercontent.com/Stardust1001/WebVPN/refs/heads/master/wxpay.jpg">
</p>


