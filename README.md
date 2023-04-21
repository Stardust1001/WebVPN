# WebVPN

### Brief
WebVPN, fully proxy all websites

### Install
npm install

### Run
run nginx with ./nginx.conf
node main.js

visit [http://127.0.0.1:1001/proxy/](http://127.0.0.1:1001/proxy/)

### Description
WebVPN can forward and proxy any third-party website "fully and completely". It is not only a VPN on the web, but also an advanced intranet penetration tool. Can also be used to make a perfect phishing site (because it reposts the target site perfectly, while also adding your own code. But I strongly advise you not to do it, illegal things are not good. I just wanted to tell you , how awesome is this WebVPN)

Believe me, WebVPN lives up to its name, and when you actually use it, you will find that it can do a lot of things you never thought possible. Although it is not yet perfect, it has the basic functions it should have.

If you are interested in this project, welcome to join me to make it better and let more people know of its existence.

### Contact
Twitter: https://twitter.com/Stardus_1001
Email: 2368354416@qq.com

### Note
从 2022-10-01 开始，后续的开发，会从 IP 部署改为域名部署，因为对目标网站的网址代理方式会做更改。
举例，之前代理 https://www.google.com/search，网址是 http://127.0.0.1:1001/proxy/all/hcraes%2Fmoc.elgoog.www%2F%2F%3Asptth。
今后，大概会是 https://d3d3Lmdvb2dsZS5jb20.webvpn.com/search 这样的形式。

之前所有的开发，网站代理和转发，都是基于网址的，把目标网址反转后拼接到 WebVPN 的网址后面。
我对此做了大量的工作，目前也基本把很多该处理的都处理了。不过，这种做法确实欠佳。但也是之前的无奈之举。

现在，我打算用更好的做法，但相对之前的方式，新做法会对部署有更高的要求。

新的做法就是，把 WebVPN 服务运行到一个域名上，把目标网址的域名编码后作为 WebVPN 网站的二级域名。目标网址的后缀，则直接放到 WebVPN 网址的后缀。

可以预见的优势是，后缀的问题基本就不需再担心了，对于 window.location 来说，只有 host hostname origin 不一样，pathname href search 这些则会保持一致。这样可以减少许多问题（也不是特别多，但应该会有尚未发现的潜在问题）。新做法肯定是值得的。

当然，稍微麻烦的一点就是，后续不能再用任意 IP 就部署 WebVPN 了，需要用域名，并且使用DNS泛解析。对于本机部署来说，自己修改本地DNS就行。
