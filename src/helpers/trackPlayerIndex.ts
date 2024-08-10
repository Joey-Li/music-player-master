import { internalFakeSoundKey, sortIndexSymbol, timeStampSymbol } from '@/constants/commonConst'
import { SoundAsset } from '@/constants/constant'
import Config from '@/store/config'
import delay from '@/utils/delay'
import { isSameMediaItem, mergeProps, sortByTimestampAndIndex } from '@/utils/mediaItem'
import { GlobalState } from '@/utils/stateMapper'
import { produce } from 'immer'
import shuffle from 'lodash.shuffle'
import ReactNativeTrackPlayer, {
	Event,
	State,
	Track,
	usePlaybackState,
	useProgress,
} from 'react-native-track-player'

import { MusicRepeatMode } from '@/helpers/types'
import PersistStatus from '@/store/PersistStatus'
import {
	getMusicIndex,
	getPlayList,
	getPlayListMusicAt,
	isInPlayList,
	isPlayListEmpty,
	setPlayList,
	usePlayList,
} from '@/store/playList'
import { createMediaIndexMap } from '@/utils/mediaIndexMap'
import { musicIsPaused } from '@/utils/trackUtils'
import { Image } from 'react-native'

import { myGetLyric, myGetMusicUrl } from '@/helpers/userApi/getMusicSource'

import { useLibraryStore } from '@/store/library'

/** 当前播放 */
const currentMusicStore = new GlobalState<IMusic.IMusicItem | null>(null)
/** 歌单*/
const playListsStore = new GlobalState<IMusic.PlayList[] | null>(null)
/** 播放模式 */
export const repeatModeStore = new GlobalState<MusicRepeatMode>(MusicRepeatMode.QUEUE)

/** 音质 */
export const qualityStore = new GlobalState<IMusic.IQualityKey>('128k')
export function useCurrentQuality() {
  const currentQuality = qualityStore.useValue();
  const setCurrentQuality = (newQuality: IMusic.IQualityKey) => {
	setQuality(newQuality);
	}
  return [currentQuality, setCurrentQuality] as const;
}
const setNowLyric = useLibraryStore.getState().setNowLyric

let currentIndex = -1

// TODO: 下个版本最大限制调大一些
// const maxMusicQueueLength = 1500; // 当前播放最大限制
// const halfMaxMusicQueueLength = Math.floor(maxMusicQueueLength / 2);
// const shrinkPlayListToSize = (
//     queue: IMusic.IMusicItem[],
//     targetIndex = currentIndex,
// ) => {
//     // 播放列表上限，太多无法缓存状态
//     if (queue.length > maxMusicQueueLength) {
//         if (targetIndex < halfMaxMusicQueueLength) {
//             queue = queue.slice(0, maxMusicQueueLength);
//         } else {
//             const right = Math.min(
//                 queue.length,
//                 targetIndex + halfMaxMusicQueueLength,
//             );
//             const left = Math.max(0, right - maxMusicQueueLength);
//             queue = queue.slice(left, right);
//         }
//     }
//     return queue;
// };

let hasSetupListener = false

// TODO: 删除
function migrate() {
	// const config = Config.get('status.music');
	// if (!config) {
	//     return;
	// }
	// const { repeatMode } = useTrackPlayerRepeatMode()
	// const {rate, repeatModeState, musicQueue, progress, track} = { 1,repeatMode,[],0, '213'};
	PersistStatus.set('music.rate', 1)
	//TODO 循环方式
	PersistStatus.set('music.repeatMode', MusicRepeatMode.QUEUE)
	// PersistStatus.set('music.playList', []);
	PersistStatus.set('music.progress', 0)
	//PersistStatus.set('music.musicItem', track);
	Config.set('status.music', undefined)
}

async function setupTrackPlayer() {
	migrate()
	const rate = PersistStatus.get('music.rate')
	const musicQueue = PersistStatus.get('music.play-list')
	const repeatMode = PersistStatus.get('music.repeatMode')
	const progress = PersistStatus.get('music.progress')
	const track = PersistStatus.get('music.musicItem')
	const quality = PersistStatus.get('music.quality') || '128k';
	const playLists = PersistStatus.get('music.playLists') ;
	// 状态恢复
	if (rate) {
		await ReactNativeTrackPlayer.setRate(+rate)
	}
	if (repeatMode) {
		repeatModeStore.setValue(repeatMode as MusicRepeatMode)
	}

	if (quality) {
		setQuality(quality as IMusic.IQualityKey)
	}
	if(playLists){
		playListsStore.setValue(playLists)
	}

	if (musicQueue && Array.isArray(musicQueue)) {
		addAll(musicQueue, undefined, repeatMode === MusicRepeatMode.SHUFFLE)
	}

	// if (track && isInPlayList(track)) {
	//     if (!Config.get('setting.basic.autoPlayWhenAppStart')) {
	//         track.isInit = true;
	//     }
	//     // 异步
	//    await api_ikun.getMusicUrl(track)
	//         .then(async newSource => {
	//             track.url = newSource?.url || track.url;
	//             track.headers = newSource?.headers || track.headers;
	//
	//             if (isSameMediaItem(currentMusicStore.getValue(), track)) {
	//                 await setTrackSource(track as Track, false);
	//             }
	//         });
	//     setCurrentMusic(track);
	//
	//     if (progress) {
	//         // 异步
	//         ReactNativeTrackPlayer.seekTo(progress);
	//     }
	// }

	if (!hasSetupListener) {
		ReactNativeTrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, async (evt) => {
			if (evt.index === 1 && evt.lastIndex === 0 && evt.track?.$ === internalFakeSoundKey) {
				console.log('队列末尾，播放下一首')
				if (repeatModeStore.getValue() === MusicRepeatMode.SINGLE) {
					await play(null, true)
				} else {
					// 当前生效的歌曲是下一曲的标记
					await skipToNext()
				}
			}
		})

		ReactNativeTrackPlayer.addEventListener(Event.PlaybackError, async (e) => {
			// WARNING: 不稳定，报错的时候有可能track已经变到下一首歌去了
			const currentTrack = await ReactNativeTrackPlayer.getActiveTrack()
			if (currentTrack?.isInit) {
				// HACK: 避免初始失败的情况

				await ReactNativeTrackPlayer.updateMetadataForTrack(0, {
					...currentTrack,
					// eslint-disable-next-line @typescript-eslint/ban-ts-comment
					// @ts-expect-error
					isInit: undefined,
				})
				return
			}

			if ((await ReactNativeTrackPlayer.getActiveTrackIndex()) === 0 && e.message) {
				console.log('播放出错', {
					message: e.message,
					code: e.code,
				})

				await failToPlay()
			}
		})

		hasSetupListener = true
		console.log('播放器初始化完成')
	}
}

/**
 * 获取自动播放的下一个track，保持nextTrack 不变,生成nextTrack的with fake url 形式  假音频
 * 获取下一个 track 并设置其属性为假音频。这在测试或处理特殊情况时非常有用
 */
const getFakeNextTrack = () => {
	let track: Track | undefined

	const repeatMode = repeatModeStore.getValue()

	if (repeatMode === MusicRepeatMode.SINGLE) {
		// 单曲循环
		track = getPlayListMusicAt(currentIndex) as Track
	} else {
		// 下一曲
		track = getPlayListMusicAt(currentIndex + 1) as Track
	}

	try {
		const soundAssetSource = Image.resolveAssetSource(SoundAsset.fakeAudio).uri
		if (track) {
			const a = produce(track, (_) => {
				_.url = soundAssetSource
				_.$ = internalFakeSoundKey
				if (!_.artwork?.trim()?.length) {
					_.artwork = undefined
				}
			})
			return a
		} else {
			// 只有列表长度为0时才会出现的特殊情况
			return { url: soundAssetSource, $: internalFakeSoundKey } as Track
		}
	} catch (error) {
		console.error('An error occurred while processing the track:', error)
	}
}

/** 播放失败时的情况 */
async function failToPlay() {
	// 自动跳转下一曲, 500s后自动跳转
	await ReactNativeTrackPlayer.reset()
	await delay(500)
	await skipToNext()
}

// 播放模式相关
const _toggleRepeatMapping = {
	[MusicRepeatMode.SHUFFLE]: MusicRepeatMode.SINGLE,
	[MusicRepeatMode.SINGLE]: MusicRepeatMode.QUEUE,
	[MusicRepeatMode.QUEUE]: MusicRepeatMode.SHUFFLE,
}
/** 切换下一个模式 */
const toggleRepeatMode = () => {
	setRepeatMode(_toggleRepeatMapping[repeatModeStore.getValue()])
}

/**
 * 添加到播放列表
 * @param musicItems 目标歌曲
 * @param beforeIndex 在第x首歌曲前添加
 * @param shouldShuffle 随机排序
 */
const addAll = (
	musicItems: Array<IMusic.IMusicItem> = [],
	beforeIndex?: number,
	shouldShuffle?: boolean,
) => {
	const now = Date.now()
	let newPlayList: IMusic.IMusicItem[] = []
	const currentPlayList = getPlayList()
	const _musicItems = musicItems.map((item, index) =>
		produce(item, (draft) => {
			draft[timeStampSymbol] = now
			draft[sortIndexSymbol] = index
		}),
	) /*draft[timeStampSymbol] = now：为 draft 对象添加或更新 timeStampSymbol 属性，值为 now。draft[sortIndexSymbol] = index：为 draft 对象添加或更新 sortIndexSymbol 属性，值为当前索引 index。*/
	if (beforeIndex === undefined || beforeIndex < 0) {
		// 1.1. 添加到歌单末尾，并过滤掉已有的歌曲
		newPlayList = currentPlayList.concat(_musicItems.filter((item) => !isInPlayList(item)))
	} else {
		// 1.2. beforeIndex新的播放列表，插入beforeIndex
		const indexMap = createMediaIndexMap(_musicItems)
		const beforeDraft = currentPlayList.slice(0, beforeIndex).filter((item) => !indexMap.has(item))
		const afterDraft = currentPlayList.slice(beforeIndex).filter((item) => !indexMap.has(item))

		newPlayList = [...beforeDraft, ..._musicItems, ...afterDraft]
	}

	// 如果太长了
	// if (newPlayList.length > maxMusicQueueLength) {
	//     newPlayList = shrinkPlayListToSize(
	//         newPlayList,
	//         beforeIndex ?? newPlayList.length - 1,
	//     );
	// }

	// 2. 如果需要随机
	if (shouldShuffle) {
		newPlayList = shuffle(newPlayList)
	}
	// 3. 设置播放列表
	setPlayList(newPlayList)
	const currentMusicItem = currentMusicStore.getValue()

	// 4. 重置下标
	if (currentMusicItem) {
		currentIndex = getMusicIndex(currentMusicItem)
	}

	// TODO: 更新播放队列信息
	// 5. 存储更新的播放列表信息
}

/** 追加到队尾 */
const add = (musicItem: IMusic.IMusicItem | IMusic.IMusicItem[], beforeIndex?: number) => {
	addAll(Array.isArray(musicItem) ? musicItem : [musicItem], beforeIndex)
}

/**
 * 下一首播放
 * @param musicItem
 */
const addAsNextTrack = (musicItem: IMusic.IMusicItem | IMusic.IMusicItem[]) => {
	const shouldPlay = isPlayListEmpty()
	add(musicItem, currentIndex + 1)
	if (shouldPlay) {
		play(Array.isArray(musicItem) ? musicItem[0] : musicItem)
	}
}
/**
 * 是当前正在播放的音频
 *
 */
const isCurrentMusic = (musicItem: IMusic.IMusicItem | null | undefined) => {
	return isSameMediaItem(musicItem, currentMusicStore.getValue()) ?? false
}
/**
 * 从播放列表移除IMusicItem
 *
 */
const remove = async (musicItem: IMusic.IMusicItem) => {
	const playList = getPlayList()
	let newPlayList: IMusic.IMusicItem[] = []
	let currentMusic: IMusic.IMusicItem | null = currentMusicStore.getValue()
	const targetIndex = getMusicIndex(musicItem)
	let shouldPlayCurrent: boolean | null = null
	if (targetIndex === -1) {
		// 1. 这种情况应该是出错了
		return
	}
	// 2. 移除的是当前项
	if (currentIndex === targetIndex) {
		// 2.1 停止播放，移除当前项
		newPlayList = produce(playList, (draft) => {
			draft.splice(targetIndex, 1)
		})
		// 2.2 设置新的播放列表，并更新当前音乐
		if (newPlayList.length === 0) {
			currentMusic = null
			shouldPlayCurrent = false
		} else {
			currentMusic = newPlayList[currentIndex % newPlayList.length]
			try {
				const state = (await ReactNativeTrackPlayer.getPlaybackState()).state
				if (musicIsPaused(state)) {
					shouldPlayCurrent = false
				} else {
					shouldPlayCurrent = true
				}
			} catch {
				shouldPlayCurrent = false
			}
		}
	} else {
		// 3. 删除
		newPlayList = produce(playList, (draft) => {
			draft.splice(targetIndex, 1)
		})
	}

	setPlayList(newPlayList)
	setCurrentMusic(currentMusic)
	if (shouldPlayCurrent === true) {
		await play(currentMusic, true)
	} else if (shouldPlayCurrent === false) {
		await ReactNativeTrackPlayer.reset()
	}
}

/**
 * 设置播放模式
 * @param mode 播放模式
 */
const setRepeatMode = (mode: MusicRepeatMode) => {
	const playList = getPlayList()
	let newPlayList
	const prevMode = repeatModeStore.getValue()

	if (
		(prevMode === MusicRepeatMode.SHUFFLE && mode !== MusicRepeatMode.SHUFFLE) ||
		(mode === MusicRepeatMode.SHUFFLE && prevMode !== MusicRepeatMode.SHUFFLE)
	) {
		if (mode === MusicRepeatMode.SHUFFLE) {
			newPlayList = shuffle(playList)
		} else {
			newPlayList = sortByTimestampAndIndex(playList, true)
		}
		setPlayList(newPlayList)
	}

	const currentMusicItem = currentMusicStore.getValue()
	currentIndex = getMusicIndex(currentMusicItem)
	repeatModeStore.setValue(mode)
	// 更新下一首歌的信息
	ReactNativeTrackPlayer.updateMetadataForTrack(1, getFakeNextTrack())
	// 记录
	PersistStatus.set('music.repeatMode', mode)
}

/** 清空播放列表 */
const clear = async () => {
	setPlayList([])
	setCurrentMusic(null)

	await ReactNativeTrackPlayer.reset()
	PersistStatus.set('music.musicItem', undefined)
	PersistStatus.set('music.progress', 0)
}
/** 清空待播列表 */
const clearToBePlayed = async () => {
  // 获取当前正在播放的音乐
  const currentMusic = currentMusicStore.getValue();

  if (currentMusic) {
    // 设置播放列表仅包含当前正在播放的音乐
    setPlayList([currentMusic]);
    setCurrentMusic(currentMusic);

    // 重置播放器并重新设置当前音轨
    // await setTrackSource(currentMusic as Track, true);
  } else {
    // 如果没有当前播放的音乐，清空播放列表
    setPlayList([]);
    setCurrentMusic(null);
    await ReactNativeTrackPlayer.reset();
  }
}

/** 暂停 */
const pause = async () => {
	await ReactNativeTrackPlayer.pause()
}

/** 设置音源 */
const setTrackSource = async (track: Track, autoPlay = true) => {
	if (!track.artwork?.trim()?.length) {
		track.artwork = undefined
	}

	//播放器队列加入track 和一个假音频，假音频的信息为实际下一首音乐的信息
	await ReactNativeTrackPlayer.setQueue([track, getFakeNextTrack()])

	PersistStatus.set('music.musicItem', track as IMusic.IMusicItem)

	PersistStatus.set('music.progress', 0)

	if (autoPlay) {
		await ReactNativeTrackPlayer.play()
	}
}
/**
 * 设置currentMusicStore，更新currentIndex
 *
 */
const setCurrentMusic = (musicItem?: IMusic.IMusicItem | null) => {
	if (!musicItem) {
		currentIndex = -1
		currentMusicStore.setValue(null)
		PersistStatus.set('music.musicItem', undefined)
		PersistStatus.set('music.progress', 0)
		return
	}
	currentIndex = getMusicIndex(musicItem)
	currentMusicStore.setValue(musicItem)
}

const setQuality = (quality: IMusic.IQualityKey) => {
	qualityStore.setValue(quality)
	PersistStatus.set('music.quality', quality)
}

const addPlayLists= (playlist: IMusic.PlayList) => {
	const nowPlayLists = playListsStore.getValue()
	nowPlayLists.push(playlist)
	playListsStore.setValue(nowPlayLists)
	PersistStatus.set('music.playLists', nowPlayLists)
}

/**
 * 播放
 *
 * 当musicItem 为空时，代表暂停/播放
 *
 * @param musicItem
 * @param forcePlay
 * @returns
 */
const play = async (musicItem?: IMusic.IMusicItem | null, forcePlay?: boolean) => {
	try {
		if (!musicItem) {
			musicItem = currentMusicStore.getValue()
		}
		if (!musicItem) {
			throw new Error(PlayFailReason.PLAY_LIST_IS_EMPTY)
		}
		// 2. 如果是当前正在播放的音频
		if (isCurrentMusic(musicItem)) {
			const currentTrack = await ReactNativeTrackPlayer.getTrack(0)
			// 2.1 如果当前有源

			if (currentTrack?.url && isSameMediaItem(musicItem, currentTrack as IMusic.IMusicItem)) {
				const currentActiveIndex = await ReactNativeTrackPlayer.getActiveTrackIndex()
				if (currentActiveIndex !== 0) {
					await ReactNativeTrackPlayer.skip(0)
				}
				if (forcePlay) {
					// 2.1.1 强制重新开始
					await ReactNativeTrackPlayer.seekTo(0)
				}
				const currentState = (await ReactNativeTrackPlayer.getPlaybackState()).state
				if (currentState === State.Stopped) {
					await setTrackSource(currentTrack)
				}
				if (currentState !== State.Playing) {
					// 2.1.2 恢复播放
					await ReactNativeTrackPlayer.play()
				}
				// 这种情况下，播放队列和当前歌曲都不需要变化
				return
			}
			// 2.2 其他情况：重新获取源
		}

		// 3. 如果没有在播放列表中，添加到队尾；同时更新列表状态
		const inPlayList = isInPlayList(musicItem)
		if (!inPlayList) {
			add(musicItem)
		}

		// 4. 更新列表状态和当前音乐
		setCurrentMusic(musicItem)
		//reset的时机？
		//await ReactNativeTrackPlayer.reset();

		// 4.1 刷新歌词信息
		const lyc = await myGetLyric(musicItem)
		// console.debug(lyc.lyric);
		setNowLyric(lyc.lyric)

		// 5. 获取音源
		let track: IMusic.IMusicItem

		// 5.1 通过插件获取音源
		// const plugin = PluginManager.getByName(musicItem.platform);
		// 5.2 获取音质排序
		const qualityOrder = ['128k', 'low']
		// const qualityOrder = getQualityOrder(
		//     Config.get('setting.basic.defaultPlayQuality') ?? 'standard',
		//     Config.get('setting.basic.playQualityOrder') ?? 'asc',
		// );
		// 5.3 插件返回的音源为source
		let source: IPlugin.IMediaSourceResult | null = null
		// for (let quality of qualityOrder) {
		//     if (isCurrentMusic(musicItem)) {
		//         source =
		//             (await plugin?.methods?.getMediaSource(
		//                 musicItem,
		//                 quality,
		//             )) ?? null;
		//         // 5.3.1 获取到真实源
		//         if (source) {
		//             setQuality(quality);
		//             break;
		//         }
		//     } else {
		//         // 5.3.2 已经切换到其他歌曲了，
		//         return;
		//     }
		// }

		if (!isCurrentMusic(musicItem)) {
			return
		}
		if (!source) {
			// 如果有source
			if (musicItem.source) {
				// console.log('成功1'+musicItem.source);
				for (const quality of qualityOrder) {
					if (musicItem.source[quality]?.url) {
						source = musicItem.source[quality]!
						setQuality(<'low' | 'standard' | 'high' | 'super'>quality)

						break
					}
				}
			}
			// console.log('成功4'+JSON.stringify(musicItem));
			// 5.4 没有返回源
			if ((!source && musicItem.url == 'Unknown') || musicItem.url.includes('fake')) {
				// 没有源。没有url
				console.log('没有源。没有url')
				const resp = await myGetMusicUrl(musicItem, qualityStore.getValue())

				source = {
					url: resp.url,
				}

				// if (Config.get('setting.basic.tryChangeSourceWhenPlayFail')) {
				// 重试
				// const similarMusic = await getSimilarMusic(
				//     musicItem,
				//     'music',
				//     () => !isCurrentMusic(musicItem),
				// );

				// if (similarMusic) {
				//     const similarMusicPlugin =
				//         PluginManager.getByMedia(similarMusic);
				//
				//     for (let quality of qualityOrder) {
				//         if (isCurrentMusic(musicItem)) {
				//             source =
				//                 (await similarMusicPlugin?.methods?.getMediaSource(
				//                     similarMusic,
				//                     quality,
				//                 )) ?? null;
				//             //c 5.4.1 获取到真实源
				//             if (source) {
				//                 setQuality(quality);
				//                 break;
				//             }
				//         } else {
				//             // 5.4.2 已经切换到其他歌曲了，
				//             return;
				//         }
				//     }
				// }

				// if (!source) {
				//     throw new Error(PlayFailReason.INVALID_SOURCE);
				// }
				// } else {
				//     throw new Error(PlayFailReason.INVALID_SOURCE);
				// }
			} else {
				source = {
					url: musicItem.url,
				}
				// setQuality('128k')
			}
		}

		// 6. 特殊类型源
		// if (getUrlExt(source.url) === '.m3u8') {
		//     // @ts-ignore
		//     source.type = 'hls';
		// }
		// 7. 合并结果
		// eslint-disable-next-line prefer-const
		track = mergeProps(musicItem, source) as IMusic.IMusicItem

		// 8. 新增历史记录
		// musicHistory.addMusic(musicItem);

		console.log('获取音源成功：', track)
		// 9. 设置音源
		//await ReactNativeTrackPlayer.reset();
		await setTrackSource(track as Track)

		// 10. 获取补充信息
		const info: Partial<IMusic.IMusicItem> | null = null
		// try {
		//     info = (await getMusicInfo?.(musicItem)) ?? null;
		//     if (
		//         (typeof info?.url === 'string' && info.url.trim() === '') ||
		//         (info?.url && typeof info.url !== 'string')
		//     ) {
		//         delete info.url;
		//     }
		// } catch {}

		// // 11. 设置补充信息
		// if (info && isCurrentMusic(musicItem)) {
		//     const mergedTrack = mergeProps(track, info);
		//     currentMusicStore.setValue(mergedTrack as IMusic.IMusicItem);
		//     await ReactNativeTrackPlayer.updateMetadataForTrack(
		//         0,
		//         mergedTrack as TrackMetadataBase,
		//     );
		// }
	} catch (e: any) {
		const message = e?.message
		if (message === 'The player is not initialized. Call setupPlayer first.') {
			await ReactNativeTrackPlayer.setupPlayer()
			play(musicItem, forcePlay)
		} else if (message === PlayFailReason.FORBID_CELLUAR_NETWORK_PLAY) {
			// if (getCurrentDialog()?.name !== 'SimpleDialog') {
			//     showDialog('SimpleDialog', {
			//         title: '流量提醒',
			//         content:
			//             '当前非WIFI环境，侧边栏设置中打开【使用移动网络播放】功能后可继续播放',
			//     });
			// }
			// Toast.warn(
			//     '当前禁止移动网络播放音乐，如需播放请去侧边栏-基本设置中修改',
			// );
		} else if (message === PlayFailReason.INVALID_SOURCE) {
			console.log('音源为空，播放失败')
			await failToPlay()
		} else if (message === PlayFailReason.PLAY_LIST_IS_EMPTY) {
			// 队列是空的，不应该出现这种情况
		}
	}
}

/**
 * 播放音乐，同时替换播放队列
 * @param musicItem 音乐
 * @param newPlayList 替代列表
 */
const playWithReplacePlayList = async (
	musicItem: IMusic.IMusicItem,
	newPlayList: IMusic.IMusicItem[],
) => {
	if (newPlayList.length !== 0) {
		const now = Date.now()
		// if (newPlayList.length > maxMusicQueueLength) {
		//     newPlayList = shrinkPlayListToSize(
		//         newPlayList,
		//         newPlayList.findIndex(it => isSameMediaItem(it, musicItem)),
		//     );
		// }
		const playListItems = newPlayList.map((item, index) =>
			produce(item, (draft) => {
				draft[timeStampSymbol] = now
				draft[sortIndexSymbol] = index
			}),
		)
		setPlayList(
			repeatModeStore.getValue() === MusicRepeatMode.SHUFFLE
				? shuffle(playListItems)
				: playListItems,
		)
		await play(musicItem, true)
	}
}

const skipToNext = async () => {
	if (isPlayListEmpty()) {
		setCurrentMusic(null)
		return
	}

	// TrackPlayer.load(getPlayListMusicAt(currentIndex + 1) as Track)
	await play(getPlayListMusicAt(currentIndex + 1), true)
}

const skipToPrevious = async () => {
	if (isPlayListEmpty()) {
		setCurrentMusic(null)
		return
	}

	await play(getPlayListMusicAt(currentIndex === -1 ? 0 : currentIndex - 1), true)
}

/** 修改当前播放的音质 */
const changeQuality = async (newQuality: IMusic.IQualityKey) => {
	// 获取当前的音乐和进度
	if (newQuality === qualityStore.getValue()) {
		return true
	}

	// 获取当前歌曲
	const musicItem = currentMusicStore.getValue()
	if (!musicItem) {
		return false
	}
	try {
		// const progress = await ReactNativeTrackPlayer.getProgress();
		// const plugin =await apiIkun.getMusicUrl(musicItem);
		// const newSource = await plugin?.methods?.getMediaSource(
		//     musicItem,
		//     newQuality,
		// );
		// if (!newSource?.url) {
		//     throw new Error(PlayFailReason.INVALID_SOURCE);
		// }
		// if (isCurrentMusic(musicItem)) {
		//     const playingState = (
		//         await ReactNativeTrackPlayer.getPlaybackState()
		//     ).state;
		//     await setTrackSource(
		//         mergeProps(musicItem, newSource) as unknown as Track,
		//         !musicIsPaused(playingState),
		//     );
		//
		//     await ReactNativeTrackPlayer.seekTo(progress.position ?? 0);
       setQuality(newQuality);
		// }
		return true
	} catch {
		// 修改失败
		return false
	}
}

enum PlayFailReason {
	/** 禁止移动网络播放 */
	FORBID_CELLUAR_NETWORK_PLAY = 'FORBID_CELLUAR_NETWORK_PLAY',
	/** 播放列表为空 */
	PLAY_LIST_IS_EMPTY = 'PLAY_LIST_IS_EMPTY',
	/** 无效源 */
	INVALID_SOURCE = 'INVALID_SOURCE',
	/** 非当前音乐 */
}

function useMusicState() {
	const playbackState = usePlaybackState()

	return playbackState.state
}

function getPreviousMusic() {
	const currentMusicItem = currentMusicStore.getValue()
	if (!currentMusicItem) {
		return null
	}

	return getPlayListMusicAt(currentIndex - 1)
}

function getNextMusic() {
	const currentMusicItem = currentMusicStore.getValue()
	if (!currentMusicItem) {
		return null
	}

	return getPlayListMusicAt(currentIndex + 1)
}

const myTrackPlayer = {
	setupTrackPlayer,
	usePlayList,
	getPlayList,
	addAll,
	add,
	addAsNextTrack,
	skipToNext,
	skipToPrevious,
	play,
	playWithReplacePlayList,
	pause,
	remove,
	clear,
	clearToBePlayed,
	useCurrentMusic: currentMusicStore.useValue,
	getCurrentMusic: currentMusicStore.getValue,
	useRepeatMode: repeatModeStore.useValue,
	getRepeatMode: repeatModeStore.getValue,
	toggleRepeatMode,
	usePlaybackState,
	setRepeatMode,
	setQuality,
	getProgress: ReactNativeTrackPlayer.getProgress,
	useProgress: useProgress,
	seekTo: ReactNativeTrackPlayer.seekTo,
	changeQuality,
	addPlayLists,
	useCurrentQuality: qualityStore.useValue,
	getCurrentQuality: qualityStore.getValue,
	getRate: ReactNativeTrackPlayer.getRate,
	setRate: ReactNativeTrackPlayer.setRate,
	useMusicState,
	reset: ReactNativeTrackPlayer.reset,
	getPreviousMusic,
	getNextMusic,
}

export default myTrackPlayer
export { MusicRepeatMode, State as MusicState }
