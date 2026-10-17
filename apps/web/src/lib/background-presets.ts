export interface BackgroundPreset {
  id: string;
  category: string;
  label: string;
  description: string;
  image: string;
  thumbnail: string;
}

interface BackgroundGroup {
  id: string;
  label: string;
  presets: BackgroundPreset[];
}

function group(id: string, label: string, scenes: [string, string, string][]): BackgroundGroup {
  return {
    id,
    label,
    presets: scenes.map(([sceneId, sceneLabel, description]) => ({
      id: sceneId,
      category: id,
      label: sceneLabel,
      description,
      image: `/backgrounds/v1/${sceneId}.webp`,
      thumbnail: `/backgrounds/v1/thumbs/${sceneId}.webp`,
    })),
  };
}

export const BACKGROUND_GROUPS: BackgroundGroup[] = [
  group('tavern', '酒馆', [
    ['tavern-hearth', '炉火大厅', '壁炉映亮木梁，温暖灯火环绕的酒馆大厅。'],
    ['tavern-seaside', '临海酒馆', '海风吹过露台，远处船帆与暮色相接。'],
    ['tavern-cellar', '地下酒窖', '石拱与橡木酒桶之间，烛火静静摇曳。'],
  ]),
  group('xuanhuan', '玄幻', [
    ['xuanhuan-palace', '云海天宫', '悬于云海之上的恢宏宫阙，天光穿过层层长阶。'],
    ['xuanhuan-ruins', '荒古秘境', '苍茫山谷深处，古老遗迹隐在幽光与藤蔓之间。'],
    ['xuanhuan-lava', '熔岩神殿', '赤红熔岩流过黑石神殿，照亮沉寂的巨柱。'],
  ]),
  group('xianxia', '仙侠', [
    ['xianxia-sect', '仙山宗门', '青峰与云雾环绕的山门，仙鹤掠过远处殿宇。'],
    ['xianxia-bamboo', '竹林道观', '翠竹掩映着清幽道观，石径延伸至薄雾深处。'],
    ['xianxia-lotus', '月下莲池', '月色落在莲池与回廊之间，水面泛起微光。'],
  ]),
  group('wuxia', '武侠', [
    ['wuxia-inn', '烟雨客栈', '细雨笼罩江湖客栈，檐下灯笼映着湿润青石。'],
    ['wuxia-temple', '雪山古刹', '雪峰下的古寺寂静肃穆，红墙映衬纷飞细雪。'],
    ['wuxia-desert', '大漠驿站', '风沙中的孤独驿站，夕阳染金远处沙丘。'],
  ]),
  group('fantasy', '西方奇幻', [
    ['fantasy-forest', '精灵古森', '古木与发光花草环绕林间小径，隐约可见精灵居所。'],
    ['fantasy-castle', '魔法城堡', '高塔与石桥耸立山间，魔法微光点亮城堡窗棂。'],
    ['fantasy-dragon', '龙骨遗迹', '巨龙遗骨横卧古老废墟，荒野延伸至遥远群山。'],
  ]),
  group('space', '太空科幻', [
    ['space-bridge', '星舰舰桥', '宽阔舰桥面向星海，控制台与舷窗映着冷色光芒。'],
    ['space-station', '轨道空间站', '环形空间站漂浮在行星上空，灯光沿长廊延伸。'],
    ['space-outpost', '异星基地', '陌生星球的岩地上，基地穹顶遥望远方行星。'],
  ]),
  group('cyberpunk', '赛博朋克', [
    ['cyberpunk-alley', '霓虹街巷', '雨水映着层叠霓虹，狭窄街巷延伸进未来都市。'],
    ['cyberpunk-apartment', '高空公寓', '落地窗外高楼林立，霓虹灯光掠过静谧公寓。'],
    ['cyberpunk-market', '地下机械集市', '管线与摊位交错的地下集市，机械零件映着灯光。'],
  ]),
  group('wasteland', '末日废土', [
    ['wasteland-city', '黄沙废城', '风沙穿过残破街道，废弃高楼沉默立于荒漠。'],
    ['wasteland-station', '植被覆盖的旧车站', '藤蔓攀上旧站台与锈轨，绿意覆盖曾经繁忙的车站。'],
    ['wasteland-shelter', '雪原避难所', '辽阔雪原中的坚固避难所，窗内透出温暖灯光。'],
  ]),
  group('urban', '都市日常', [
    ['urban-study', '雨夜书房', '雨滴滑过窗玻璃，台灯照亮安静的书桌。'],
    ['urban-cafe', '午后咖啡馆', '阳光洒过窗边桌椅，咖啡馆里留下慵懒午后的光影。'],
    ['urban-rooftop', '城市天台', '开阔天台俯瞰城市，晚风中灯火逐渐亮起。'],
  ]),
  group('school', '校园青春', [
    ['school-classroom', '夕阳教室', '金色夕阳穿过教室窗户，课桌与黑板笼罩在余晖中。'],
    ['school-sakura', '樱花校园', '樱花飘落在校园小径，教学楼隐约映在花枝之间。'],
    ['school-library', '夜间图书馆', '夜色中的图书馆灯火柔和，书架与长桌静候读者。'],
  ]),
  group('palace', '古风宫廷', [
    ['palace-hall', '华灯大殿', '华灯照亮金红宫殿，层层帷幔与雕梁延伸至深处。'],
    ['palace-garden', '春日御花园', '春花环绕亭台与水榭，曲径穿过精致宫苑。'],
    ['palace-snow', '雪夜宫廊', '细雪落在红墙与宫廊之间，灯笼点亮冬夜。'],
  ]),
  group('mystery', '悬疑诡秘', [
    ['mystery-harbor', '雾港街道', '浓雾笼罩港口街道，路灯与船影若隐若现。'],
    ['mystery-study', '古宅书房', '古宅中布满旧书与尘埃的书房，微光照亮深色木桌。'],
    ['mystery-hospital', '废弃医院', '荒废走廊延伸至幽暗深处，残破窗户透入冷光。'],
  ]),
];

export const BACKGROUND_PRESETS: BackgroundPreset[] = BACKGROUND_GROUPS.flatMap((category) => category.presets);

export function getBackgroundPreset(background: string): BackgroundPreset | undefined {
  return BACKGROUND_PRESETS.find((preset) => preset.image === background);
}
