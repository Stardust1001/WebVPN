use std::io::prelude::*;
use std::net::TcpListener;
use std::net::TcpStream;

use crate::config::Config;
use crate::pool::ThreadPool;

#[derive(Debug)]
pub struct WebVPN {
	pub config: Config,
	pub name: String
}

impl WebVPN {
	pub fn start(&self) {
		println!("WebVPN start ...");
		self.run();
	}

	fn run(&self) {
		let address = format!("0.0.0.0:{}", self.config.port);
		println!("{}", address);
		let listener = TcpListener::bind(address).unwrap();

		let pool = ThreadPool::new(50);

		for stream in listener.incoming() {
			let stream = stream.unwrap();
			pool.execute(|| {
				self.route(stream);
			});
		}
	}

	fn route(&self, stream: TcpStream) {
		self.respond(stream, String::from("haha"));
	}

	fn respond(&self, mut stream: TcpStream, text: String) {
		let mut response = String::from("HTTP/1.1 200 OK\r\n");
		response += &String::from(format!("Content-Length: {}\r\n\r\n", text.len()));
		response += &text;
		stream.write(response.as_bytes()).unwrap();
		stream.flush().unwrap();
	}
}
