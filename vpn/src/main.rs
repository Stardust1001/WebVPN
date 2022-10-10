use crate::webvpn::WebVPN;
use crate::config::Config;

pub mod webvpn;
pub mod config;

fn main() {
	println!("Guten morgen");

	let config = Config {
		port: 8000,
		num_processes: 4,
		cache: false,
		cache_dir: String::from("cache"),
		intercept_log: false,
		disable_jump: false,
		confirm_jump: false,
		hide_chinease: false
	};
	println!(
		"{}, {}, {}, {}, {}, {}, {}, {}",
		config.port,
		config.num_processes,
		config.cache,
		config.cache_dir,
		config.intercept_log,
		config.disable_jump,
		config.confirm_jump,
		config.hide_chinease
	);
	let webvpn = WebVPN {
		config,
		name: String::from("webvpn")
	};
	println!("{}", webvpn.name);
	println!("{:?}", webvpn);
	webvpn.start();
}
